import type {
  AgentMode,
  BuiltinSubagentDef,
  BuiltinSubagentsSetting,
  BuiltinToolName,
} from "@acpio/shared";
import {
  BUILTIN_SUBAGENT_MAX_TURNS_CAP,
  BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT,
  BUILTIN_TOOL_NAMES,
} from "@acpio/shared";
import type { ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { runTurn, type TurnModel } from "./loop.js";
import type { AskPermission } from "./tools.js";

/** One child report is clipped to this — the parent's context is the budget. */
export const SUBAGENT_RESULT_MAX_CHARS = 16_000;
/** Parallel children per turn; more spawn but wait for a slot. */
export const SUBAGENT_MAX_PARALLEL = 3;

/**
 * The built-in explorer: read-only research. Lives in code, not in settings —
 * the settings roster stores only user-defined agents.
 */
export const EXPLORE_SUBAGENT: BuiltinSubagentDef = {
  id: "builtin-explore",
  name: "explore",
  description: "Read-only code investigation: locate, trace, survey.",
  systemPrompt:
    "You are a codebase explorer. You investigate a repository with read-only tools " +
    "and answer one research question.",
  tools: ["read", "glob", "grep"],
  maxTurns: BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT,
};

/** Roster the model can address by name: built-in explore first, then user-defined. */
export function subagentRoster(
  settings: BuiltinSubagentsSetting | undefined,
): BuiltinSubagentDef[] {
  return [EXPLORE_SUBAGENT, ...(settings?.agents ?? [])];
}

/**
 * Appended to every child system prompt. The child's final message is the only
 * thing the parent receives — this contract is what keeps that one message
 * worth its tokens even when the caller's own prompt for the child is sloppy.
 */
const REPORT_CONTRACT = [
  "Working rules:",
  "- Your final message is the deliverable: the caller reads it verbatim and sees nothing else of your run.",
  "- Report findings, not activity: dense facts, paths with line references (`path:line`), " +
    "a short code quote only where it decides the answer. No narration of steps, no preamble.",
  "- Stop and report as soon as you can answer; a partial true answer beats a late complete one.",
].join("\n");

/** Tool names a child may hold in the parent's current mode. */
function availableTools(mode: AgentMode): readonly string[] {
  return mode === "agent" ? BUILTIN_TOOL_NAMES : ["read", "glob", "grep"];
}

/**
 * Bounds concurrent children and hands back a release function. `acquire`
 * rejects on the turn's abort signal so a cancelled turn never parks on a slot.
 */
class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("cancelled");
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    const grant = new Promise<() => void>((resolve) => this.waiters.push(() => {
      this.active += 1;
      resolve(() => this.release());
    }));
    const abort = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    return Promise.race([grant, abort]);
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

/**
 * Everything a child run needs from the parent turn. One bridge per prompt:
 * the slot semaphore and the usage accumulator must span the turn and its
 * wrap-up continuation.
 */
export interface SubagentsBridge {
  mode: AgentMode;
  /** The parent's permission gate, so a child's mutating call asks the same user. */
  ask: AskPermission;
  /** The parent turn's model — children share the endpoint, model and signal. */
  model: TurnModel;
  contextWindow: number;
  cwd: string;
  signal: AbortSignal;
  settings: BuiltinSubagentsSetting;
  emit: (update: Record<string, unknown>) => void;
  /** The parent's mode toolset WITHOUT the task tool — children cannot nest. */
  buildChildTools: (ask: AskPermission) => ToolSet;
  /** Tokens spent by finished children this prompt, folded into the turn usage. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  };
  /** toolCallId → final report, for the harness to show in the subagent card. */
  results: Map<string, string>;
  slots: Semaphore;
}

export function createSubagentsBridge(parts: {
  mode: AgentMode;
  ask: AskPermission;
  model: TurnModel;
  contextWindow: number;
  cwd: string;
  signal: AbortSignal;
  settings: BuiltinSubagentsSetting;
  emit: (update: Record<string, unknown>) => void;
  buildChildTools: (ask: AskPermission) => ToolSet;
}): SubagentsBridge {
  return {
    ...parts,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    results: new Map(),
    slots: new Semaphore(SUBAGENT_MAX_PARALLEL),
  };
}

/** Input of the `task` tool, as the model sends it. */
export interface TaskToolInput {
  agent?: string;
  system_prompt?: string;
  tools?: string[];
  prompt: string;
}

const taskInputSchema = z.object({
  // `agent`/`system_prompt`/`tools` carry no per-field descriptions: the tool
  // description above states them, and every field here rides each model call.
  agent: z.string().optional(),
  system_prompt: z.string().optional(),
  tools: z.array(z.enum(BUILTIN_TOOL_NAMES)).optional(),
  prompt: z.string().min(1).describe("The child's task; it sees no conversation history."),
});

/** The `task` tool: spawns a child run and returns its final report. */
export function makeTaskTool(bridge: SubagentsBridge) {
  const roster = subagentRoster(bridge.settings);
  // This description rides every model call of the session — the feature's
  // whole standing cost is this string plus the schema, so it stays tight.
  const named = roster.map((a) => `${a.name} — ${a.description}`).join("; ");
  const rules = bridge.settings.allowAdhoc
    ? "Pass `agent` (a roster name) or `system_prompt` (ad-hoc child; its `tools` default to " +
      "read/glob/grep), never both; children cannot spawn subagents."
    : "Pass `agent`, a roster name — ad-hoc children are disabled; children cannot spawn subagents.";
  return tool({
    // This description rides every model call of the session — the feature's
    // whole standing cost is this string plus the schema, so it stays tight,
    // and it only states mechanics: nothing here demands a spawn.
    description:
      "Run a subagent in its own context; only its final report returns. " +
      `${rules} Named: ${named}`,
    inputSchema: taskInputSchema,
    execute: async (input, ctx) => {
      const report = await runSubagent(bridge, ctx.toolCallId, input);
      bridge.results.set(ctx.toolCallId, report);
      return report;
    },
  });
}

/** Resolve the definition behind one `task` call. */
export function resolveSubagent(
  bridge: SubagentsBridge,
  input: TaskToolInput,
): BuiltinSubagentDef {
  const named = input.agent?.trim().toLowerCase();
  const adhocPrompt = input.system_prompt?.trim();
  if (named && adhocPrompt) {
    throw new Error("Pass either `agent` or `system_prompt`, not both.");
  }
  if (named) {
    const found = subagentRoster(bridge.settings).find((a) => a.name === named);
    if (!found) {
      const names = subagentRoster(bridge.settings)
        .map((a) => a.name)
        .join(", ");
      throw new Error(`Unknown subagent "${named}". Available: ${names}.`);
    }
    return found;
  }
  if (adhocPrompt) {
    if (!bridge.settings.allowAdhoc) {
      throw new Error("Ad-hoc subagents are disabled — pass `agent` with a name from the roster.");
    }
    const requested = (input.tools ?? []).filter((t): t is BuiltinToolName =>
      (availableTools(bridge.mode) as readonly string[]).includes(t),
    );
    return {
      id: "adhoc",
      name: "ad-hoc",
      description: "",
      systemPrompt: adhocPrompt,
      tools: requested.length ? [...new Set(requested)] : ["read", "glob", "grep"],
      maxTurns: BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT,
    };
  }
  throw new Error("Pass `agent` (a name from the roster) or `system_prompt` (an ad-hoc role).");
}

/** Last assistant text in the child's produced messages — its final report. */
function finalText(response: ModelMessage[]): string {
  for (let i = response.length - 1; i >= 0; i -= 1) {
    const message = response[i];
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

function clipResult(report: string): string {
  if (report.length <= SUBAGENT_RESULT_MAX_CHARS) return report;
  return `${report.slice(0, SUBAGENT_RESULT_MAX_CHARS)}\n…[report truncated at ${SUBAGENT_RESULT_MAX_CHARS} chars]`;
}

/**
 * One child run: fresh context, the resolved definition's system prompt plus
 * the report contract, a toolset cut down to the definition's tools ∩ the
 * parent's mode. The child's transcript never reaches the parent — only the
 * returned report does (as the tool result, hence into the stored history).
 */
export async function runSubagent(
  bridge: SubagentsBridge,
  toolCallId: string,
  input: TaskToolInput,
): Promise<string> {
  const def = resolveSubagent(bridge, input);
  const label = def.name;
  const tools = def.tools.filter((t) => availableTools(bridge.mode).includes(t));
  // No bridge into the child toolset: `task` never appears twice.
  const childTools = bridge.buildChildTools((call) =>
    bridge.ask({ ...call, title: `[${label}] ${call.title}` }),
  );
  const picked: ToolSet = {};
  for (const name of tools) {
    const candidate = childTools[name];
    if (candidate) picked[name] = candidate;
  }

  const release = await bridge.slots.acquire(bridge.signal);
  let step = 0;
  try {
    const childEmit = (update: Record<string, unknown>): void => {
      if (update.sessionUpdate === "usage_update") {
        bridge.usage.inputTokens += Number(update.inputTokens ?? 0) || 0;
        bridge.usage.outputTokens += Number(update.outputTokens ?? 0) || 0;
        bridge.usage.cachedInputTokens += Number(update.cachedInputTokens ?? 0) || 0;
        bridge.usage.totalTokens += Number(update.used ?? 0) || 0;
        return;
      }
      // Live activity for the parent's card: one thinking line per child tool
      // call. The counter keeps lines unique — the harness dedupes by text.
      if (update.sessionUpdate === "tool_call") {
        step += 1;
        bridge.emit({
          sessionUpdate: "tool_call_content_chunk",
          toolCallId,
          content: [
            { type: "thinking", text: `${step} · ${String(update.title ?? update.toolName ?? "tool")}` },
          ],
        });
      }
      // Text/thought chunks and tool results are not forwarded: the child's
      // report arrives once, as this tool's return value.
    };
    const outcome = await runTurn({
      model: bridge.model,
      system: [def.systemPrompt.trim(), `Working directory: ${bridge.cwd}`, REPORT_CONTRACT].join(
        "\n\n",
      ),
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
      tools: picked,
      abortSignal: bridge.signal,
      contextWindow: bridge.contextWindow,
      maxSteps: Math.min(def.maxTurns, BUILTIN_SUBAGENT_MAX_TURNS_CAP),
      emit: childEmit,
    });
    // Clip before annotating: the budget note must survive the cut.
    let report = clipResult(finalText(outcome.response));
    if (outcome.stepBudgetHit) {
      report += "\n\n[subagent] Step budget exhausted; the report may be incomplete.";
    }
    if (!report.trim()) {
      report = bridge.signal.aborted
        ? "[subagent] cancelled before a report was produced."
        : "[subagent] returned no report.";
    }
    // Already clipped above, after the budget note was appended.
    return report;
  } finally {
    release();
  }
}
