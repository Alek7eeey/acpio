import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  AgentMode,
  AppSettings,
  BuiltinProviderConfig,
  InProcessAgentOptions,
  InProcessAgentTransport,
} from "@acpio/shared";
import { builtinProviderHeaders, normalizeBuiltinThinkingLimit, parseBuiltinBody } from "@acpio/shared";
import { generateText, type ModelMessage, type ToolSet } from "ai";
import {
  builtinModelOptions,
  hasBuiltinEndpoint,
  initialModelId,
  resolveBuiltinModel,
  subagentModelChoice,
  type BuiltinModelSelection,
} from "./config.js";
import { createHostRpc } from "./host.js";
import {
  OffloadStore,
  offloadToolResults,
} from "./offload.js";
import {
  compactHistory,
  digestMessage,
  estimateTokens,
  hasReasoning,
  MAX_TURN_ATTEMPTS,
  maskToolResults,
  pruneMessages,
  promptView,
  runTurn,
  runTurnWithRetry,
  type CompactionState,
  type TurnModel,
  type TurnOutcome,
} from "./loop.js";
import { McpManager, mcpToolSet, parseMcpServers } from "./mcp.js";
import {
  discoverSkills,
  expandSkillInvocation,
  renderSkillsSection,
  type BuiltinSkill,
} from "./skills.js";
import { isValidSessionId, loadBuiltinSession, saveBuiltinSession } from "./store.js";
import { createBuiltinTools } from "./tools.js";
import {
  createSubagentsBridge,
  type SubagentsBridge,
} from "./subagents.js";

const AGENT_INFO = { name: "acpio-builtin", title: "Built-in agent", version: "0.1.0" };
const MODES: readonly string[] = ["agent", "plan", "ask"];

/** First text part of a prompt's content blocks — what `/skill` matching sees. */
function promptText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  for (const part of parts) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      return String((part as { text?: unknown }).text ?? "");
    }
  }
  return "";
}

/**
 * The user message: text parts plus image attachments. Harness-side attachments
 * arrive as ACP `image` blocks (base64); `file` is accepted too for the same
 * shape. Non-image files are dropped — they are named in the text hint and the
 * model opens them with the `read` tool.
 */
function userContent(parts: unknown): ModelMessage {
  const content: Array<
    { type: "text"; text: string } | { type: "file"; mediaType: string; data: string }
  > = [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as {
        type?: unknown;
        text?: unknown;
        mediaType?: unknown;
        mimeType?: unknown;
        data?: unknown;
      };
      if (p.type === "text") {
        content.push({ type: "text", text: String(p.text ?? "") });
      } else if (p.type === "image" && p.data) {
        content.push({
          type: "file",
          mediaType: String(p.mimeType ?? p.mediaType ?? "image/png"),
          data: String(p.data),
        });
      } else if (p.type === "file" && p.data && /^image\//.test(String(p.mediaType ?? ""))) {
        content.push({ type: "file", mediaType: String(p.mediaType), data: String(p.data) });
      }
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { role: "user", content };
}

/** Mode is enforced by the tool set; the prompt only tells the model about it. */
function systemPrompt(
  locale: string,
  cwd: string,
  mode: AgentMode,
  mcp: { servers: string[]; tools: string[] },
  skills: readonly BuiltinSkill[],
  /** Settings → Built-in agent let the tools leave the working directory. */
  outsideCwd: boolean,
  /** Settings → Built-in agent: the user's own instructions, appended last. */
  extraInstructions: string,
): string {
  const scope =
    mode === "agent"
      ? "You may edit files and run commands. Verify changes with a build or a test run when the project offers one."
      : mode === "plan"
        ? "Plan mode: you have read-only access. Investigate and propose — never claim an edit was made."
        : "Answer mode: answer the question directly; read files when they are needed.";
  return [
    "You are the built-in coding agent of the Acpio chat harness.",
    `Working directory: ${cwd}`,
    ...(outsideCwd
      ? [
          "Paths outside the working directory work too (the user allowed it in settings): " +
            "absolute paths such as a global skill folder are readable, and `grep`/`glob` may " +
            "scope to one. Keep new files inside the working directory unless the user points " +
            "you elsewhere.",
        ]
      : []),
    `Reply in ${locale === "ru" ? "Русский" : "English"}. Use Markdown; keep answers short and concrete.`,
    "",
    "Rules:",
    "- Read a file before changing it; make the smallest change that fully solves the task.",
    "- A bug report is also a spec: every behavior it states must hold after the fix the way it " +
      "held before. Where the wording is ambiguous, mirror what the unfixed code already did on " +
      "that path — only the reported defect changes.",
    "- Fix the cause, not the site where the symptom shows. When the issue's wording settles " +
      "the expected behavior ('instead of'), that is a replacement, not an addition. Before " +
      "finishing, exercise the changed function itself on every case the task names or " +
      "enumerates — such a list is a checklist for your verification, not a suggestion.",
    "- When the task asks for a new file, write it — the workspace is usually empty, " +
      "so do not survey it first; a listing tells you nothing you need.",
    "- Never invent paths, flags or APIs — read the directory or the file first.",
    "- Use `read` to examine a file, not `cat`/`sed`/`tail` through `bash`; use `glob`/`grep` " +
      "to find things, not `find`/`grep` through `bash`.",
    "- Use `edit` for changes to an existing file and `write` only for a new file or a complete " +
      "rewrite. Put every change to one file in a single `edit` call: each `old_string` is matched " +
      "against the file as it is now, so entries must not overlap or nest.",
    "- Batch independent calls in one step (several reads, searches or unrelated commands); " +
      "run a command only after the call it depends on has finished.",
    "- After running a command, check its exit code before believing the output.",
    "- If a failing check encodes the old behavior the task asks to change, do not guess the " +
      "replacement from the task wording: implement through the canonical mechanism the " +
      "environment already provides (an installed library, a platform standard) instead of " +
      "hand-rolling a path or format. When that means importing a third-party library the " +
      "project does not depend on yet, add it to the dependency manifest (setup.cfg / " +
      "pyproject.toml / package.json) — a clean install must keep working.",
    "- When the project is a public repository, check its actual history for the canonical fix " +
      "(`git log -S` in the checkout, a released version from the registry) instead of " +
      "reconstructing it from memory; adapt what you find to this checkout — a couple of " +
      "targeted lookups, not a survey. Port the canonical fix's whole change set, not just the " +
      "hunk nearest the symptom: when the fix moves work between sites (a helper stops " +
      "converting, a caller must), update every site that consumed the old behavior. Its " +
      "breadth is the upstream's to define too: when the canonical change is broader than the " +
      "symptom suggests (a global flag, a looser grammar), keep that breadth and adapt the " +
      "neighboring code it affects — do not narrow the fix to look safe.",
    "- Verify with the check the task names, once: if it fails, fix the code, never the check. " +
      "Stop as soon as it passes — no extra listings, re-reads or cleanup unless asked. One green " +
      "run settles it: no suite re-runs, no `git stash` baseline comparisons, and failures " +
      "unrelated to the change are out of scope.",
    "- Derive a self-written verification from the contract, not from the patch: every clause " +
      "the task states becomes an assertion, including the edge case that separates fixed from " +
      "unfixed (a read after expiry, an entry at a stale index). Assert through the door the " +
      "report used: the function the report shows misbehaving sits inside the assertions " +
      "themselves, queried past the fixed-vs-unfixed boundary — before the fix and after it. " +
      "An observer that already agreed before the fix (`has`, `size`, a log line) cannot see " +
      "this defect and proves nothing. Give the check its negative control: run it against the " +
      "unfixed code first and watch it fail. If your script and the code " +
      "disagree, the contract decides which one lies — never relax the check to go green.",
    "- If you wrote throwaway tests or fixtures to verify your work, delete them before " +
      "finishing unless the task asked for tests: a clean diff carries only the fix, and " +
      "scratch files left under the project's test tree break any patch applied on top of it.",
    "- `bash` is a POSIX shell on every platform (Git Bash on Windows): pipes, `&&` and " +
      "single/double quotes behave like bash, and paths may use `/`. Prefer one direct command " +
      "(`sed`, `perl -pi`, a short `node -e` rewrite) over writing a helper script and debugging " +
      "it — every debug round is a wasted step.",
    `- ${scope}`,
    ...(extraInstructions.trim()
      ? ["", "Additional instructions from the user (follow them):", extraInstructions.trim()]
      : []),
    ...(mcp.tools.length
      ? [
          "",
          `MCP servers connected: ${mcp.servers.join(", ")}. Their tools are prefixed \`mcp__\`:`,
          mcp.tools.join(", "),
        ]
      : []),
    renderSkillsSection(skills),
  ].join("\n");
}

/**
 * Endpoint client for one provider: its URL, key and headers, plus any extra
 * request body the provider configures (Settings → Built-in agent). The extra
 * object merges over the built body, so a provider-specific knob the
 * OpenAI-compatible schema has no field for — MiMo's `thinking`, an
 * `reasoning_effort` — reaches the endpoint. `{{sessionId}}` in a header value
 * resolves to the asking session.
 */
function builtinEndpoint(
  provider: BuiltinProviderConfig,
  sessionId: string,
  extraBody?: Record<string, unknown>,
) {
  // Provider body first, the per-turn override on top: the turn's pick (the
  // `thinking` the user chose in the ⋯ menu) is the more specific intent.
  const extra = { ...(parseBuiltinBody(provider.body) ?? {}), ...(extraBody ?? {}) };
  return createOpenAICompatible({
    name: `builtin:${provider.id}`,
    baseURL: provider.url,
    apiKey: provider.apiKey || undefined,
    // Most OpenAI-compatible servers only report usage when asked to.
    includeUsage: true,
    headers: builtinProviderHeaders(provider.headers, sessionId),
    ...(Object.keys(extra).length > 0
      ? {
          transformRequestBody: (args: Record<string, any>) => ({ ...args, ...extra }),
        }
      : {}),
  });
}

/**
 * Reasoning modes the ⋯ menu offers per model, in chip order. They shape the
 * prompt only: "Low" asks for a short private-reasoning budget, "Default"
 * leaves the prompt alone. Whether the endpoint thinks at all is a separate,
 * session-level wire switch — `/thinking` (see `thinkingOff`).
 */
const THINKING_MODES = ["default", "low", "extra-low"] as const;

type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * Body field that switches an endpoint's thinking pass off. Endpoints with a
 * thinking knob (MiMo's `thinking`, the common relay switches) honour it; the
 * rest ignore an unknown field.
 */
const THINKING_DISABLED_BODY = { thinking: { type: "disabled" } };

/** `/thinking [on|off]` — bare means "toggle". */
const THINKING_COMMAND_RE = /^\/thinking(?:\s+(\S+))?\s*$/i;

/** `/thinking-limit [on|off|<chars>]` — bare reports the current state. */
const THINKING_LIMIT_COMMAND_RE = /^\/thinking-limit(?:\s+(\S+))?\s*$/i;

/** The fuse's default line: one step's thinking past this is cut. */
const THINKING_LIMIT_DEFAULT_CHARS = 3_000;

/**
 * What "Low" appends to the system prompt: a budget rule, which is the only
 * lever that survived measurement. It has to be stated as a hard failure — a
 * preference gets reasoned around by a model that enjoys reasoning.
 */
const THINKING_LOW_INSTRUCTION =
  "Hard rule: your private reasoning budget is 150 words. Think once, decide, " +
  "then answer. No enumeration of options, no re-derivation of obvious facts, " +
  "no restating the task, no planning commentary. Exceeding the budget is a " +
  "failure; write the answer immediately once you have decided.";

/**
 * What "Extra low" appends: the 150-word rule still left room for the failure
 * the harness actually saw — long rumination inside one step (a single
 * reasoning block grew past 17k chars while the model explored a repo). This
 * one caps the per-step chain of thought, prices thinking in the user's own
 * money, and names the rumination shapes (recaps, plans, option lists,
 * "now let me" narration) as bugs rather than diligence.
 */
const THINKING_EXTRA_LOW_INSTRUCTION =
  "Hard rule: private reasoning is capped at 3 sentences per step and ~60 " +
  "words total. Observe, decide in one sentence, act. Thinking longer is a " +
  "billing failure, not diligence: no recaps of what you just read, no plans " +
  "before acting, no lists of options you will not try, no \"now let me\" " +
  "narration, no re-deriving facts already on screen. If a thought reaches a " +
  "second paragraph, stop mid-sentence and emit the tool call or the answer.";

/** The per-mode system-prompt rider; "default" leaves the prompt alone. */
const THINKING_INSTRUCTIONS: Record<ThinkingMode, string> = {
  default: "",
  low: THINKING_LOW_INSTRUCTION,
  "extra-low": THINKING_EXTRA_LOW_INSTRUCTION,
};

/**
 * ACP endpoint that runs inside the server process: the same JSON-RPC frames a
 * spawned CLI would put on stdio, with no external binary to install.
 *
 * One transport serves one session. Conversations live in `stateDir` so
 * `session/load` can restore them after a restart; the harness keeps its own
 * copy and never replays, hence `suppressReplayOnLoad`.
 */
export class BuiltinAgent implements InProcessAgentTransport {
  private out: ((line: string) => void) | null = null;
  private closed: ((info?: { message?: string }) => void) | null = null;
  private stopping = false;
  private readonly rpc = createHostRpc((frame) => this.send(frame));
  private readonly opts: InProcessAgentOptions;

  private sessionId = "";
  private cwd: string;
  private mode: AgentMode;
  private modelId: string;
  /** Per-model reasoning mode picked in the composer (see `configOptions`). */
  private thinking: ThinkingMode = "default";
  /** `/thinking off`: requests carry a body that switches the thinking pass off. */
  private thinkingOff = false;
  /**
   * `/thinking-limit`: chars of one step's private reasoning before the fuse
   * cuts the model call mid-think and the turn carries on with a reminder.
   * The effective threshold: the chat's {@link thinkingLimitOverride} if it
   * has one, else the global `builtinThinkingLimit` setting — recomputed by
   * {@link applyThinkingLimit} wherever live settings are read.
   * 0 = off. Session-level and wire-free — the prompt-shaped sibling of
   * `thinkingOff`, which kills the thinking pass itself.
   */
  private thinkingLimit = 0;
  /**
   * What `/thinking-limit` decided for this chat: a number (0 = off here even
   * when the global setting arms the fuse), or `undefined` to follow the
   * global setting. Persisted, so a restart keeps the choice.
   */
  private thinkingLimitOverride: number | undefined;
  private messages: ModelMessage[] = [];
  /** Digest of the covered prefix — see {@link CompactionState}. */
  private compaction: CompactionState | undefined;
  /** Stored-message boundary the mask covers; advanced only when a pass runs. */
  private maskUpTo = 0;
  /**
   * Stored index the prune mode view starts at. Sticky: recomputing the cut on
   * every turn would rewrite the head of every later request while a provider
   * charges the whole view again for it.
   */
  private prunedFrom = 0;
  /**
   * System prompt the last turn sent. The summariser reuses it verbatim so its
   * own request stays a prefix of that turn's — see `ask`.
   */
  private lastSystem = "";
  /**
   * Tool declarations the last turn sent. Rendered ahead of the messages, they
   * are part of the cached prefix — the summariser reuses them verbatim.
   */
  private lastTools: ToolSet | undefined;
  /** Archive of bulky tool results for this session, when offloading is on. */
  private offload: OffloadStore | undefined;
  private abort: AbortController | null = null;
  /** Set for the duration of one prompt: the subagent bridge, if enabled. */
  private activeSubagents: SubagentsBridge | null = null;
  /**
   * Model spend of this session to date, as the rows of the context panel count
   * it: every billing figure this agent puts on a `usage_update` is one of
   * these totals, never the scope of the report that happens to carry it (one
   * call, one turn, one compaction pass, one child). The harness stores the
   * latest update as-is — it never adds them up — so a snapshot scoped to
   * whatever just happened is what made the panel's in/out rows jump backwards
   * mid-run; a session-scoped snapshot can only grow, and each report only ever
   * adds what it is the first to report.
   */
  private sessionUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /**
   * Subagent spend already folded into `sessionUsage`. The bridge's own counter
   * is a running total for the prompt, so only its growth is new money — the
   * rest was billed by an earlier update of the same prompt.
   */
  private bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /**
   * Model spend of this prompt's compaction passes that no usage report has
   * carried to the panel yet. The harness overwrites — never accumulates — usage
   * per update, so a summariser call left out of the turn's report is left out
   * of the session's totals for good: the first squeeze in a measured run was
   * 11 353 in / 560 out the panel and the bench rows never saw. Its money goes
   * into `sessionUsage` where the call is made; this stays the flag that decides
   * whether `/compact` has a bill worth reporting at all.
   */
  private pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  /**
   * Last context size the provider itself measured. A `/compact` pass has no
   * turn to report into, and the squeezed size is only measurable on the next
   * call — so its usage update keeps the chip on the size that was measured.
   */
  private lastMeasuredUsed = 0;
  /**
   * Mid-turn messages the host asked for (`session/steer`): each one resolves
   * when the model loop really folds it into a prompt, or with `false` when the
   * turn it was aimed at ended first — the host then queues it as usual.
   */
  private steers: Array<{ text: string; resolve: (delivered: boolean) => void }> = [];
  /** Rebuilt per session: `session/new` carries that session's `mcpServers`. */
  private mcp = new McpManager([], (toolCall) => this.askPermission(toolCall));

  constructor(opts: InProcessAgentOptions) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.mode = opts.mode;
    this.modelId = initialModelId(opts.settings);
  }

  // ── InProcessAgentTransport ───────────────────────────────────────────────

  write(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (this.rpc.receive(msg)) return;
    void this.handle(msg).catch((err) => this.replyError(msg, err));
  }

  onLine(cb: (line: string) => void): void {
    this.out = cb;
  }

  onClose(cb: (info?: { message?: string }) => void): void {
    this.closed = cb;
  }

  close(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.abort?.abort();
    this.mcp.close();
    this.rpc.failAll(new Error("встроенный агент остановлен"));
    this.closed?.();
  }

  // ── JSON-RPC ──────────────────────────────────────────────────────────────

  /** No sink is a hard error: a request that can never be answered must reject. */
  private send(frame: Record<string, unknown>): void {
    if (this.stopping || !this.out) throw new Error("встроенный агент не подключён");
    this.out(JSON.stringify(frame));
  }

  private replyError(msg: Record<string, unknown>, err: unknown): void {
    if (this.stopping || !this.out || msg.id === undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    this.out(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } }));
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    const method = msg.method;
    if (typeof method !== "string") return;
    if (msg.id === undefined) {
      if (method === "session/cancel") this.abort?.abort();
      return;
    }
    try {
      const result = await this.dispatch(method, (msg.params ?? {}) as Record<string, unknown>);
      this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (err) {
      this.replyError(msg, err);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: AGENT_INFO,
        };
      case "session/new":
        return this.openSession(
          randomUUID(),
          String(params.cwd ?? this.opts.cwd),
          false,
          params.mcpServers,
        );
      case "session/load": {
        const requested = String(params.sessionId ?? "");
        // The id becomes a file name and rides along in every update — reject
        // anything that is not a plain token instead of accepting it silently.
        if (requested && !isValidSessionId(requested)) {
          throw new Error(`Некорректный id сессии: ${requested}`);
        }
        return this.openSession(
          requested || randomUUID(),
          String(params.cwd ?? this.opts.cwd),
          true,
          params.mcpServers,
        );
      }
      case "session/prompt":
        return this.prompt(params);
      case "session/steer":
        return this.steer(params);
      case "session/cancel":
        this.abort?.abort();
        return {};
      case "session/set_mode": {
        const modeId = String(params.modeId ?? "");
        if (MODES.includes(modeId)) this.mode = modeId as AgentMode;
        return {};
      }
      case "session/set_config_option": {
        const configId = String(params.configId ?? "");
        const value = String(params.value ?? "").trim();
        if (configId === "model" && value) {
          const picked = resolveBuiltinModel(this.opts.settings, value);
          if (!picked) {
            throw new Error(
              `Модель "${value}" не найдена в настройках встроенного агента — Настройки → Встроенный агент.`,
            );
          }
          this.modelId = picked.value;
        } else if (configId === "thinking") {
          if ((THINKING_MODES as readonly string[]).includes(value)) {
            this.thinking = value as ThinkingMode;
          }
        }
        return { configOptions: this.configOptions() };
      }
      default:
        throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
    }
  }

  // ── Session state ─────────────────────────────────────────────────────────

  private async openSession(
    sessionId: string,
    cwd: string,
    restore = false,
    mcpServers?: unknown,
  ) {
    const stored = restore ? loadBuiltinSession(this.opts.stateDir, sessionId) : undefined;
    this.mcp.close();
    this.mcp = new McpManager(parseMcpServers(mcpServers), (toolCall) => this.askPermission(toolCall));
    this.sessionId = sessionId;
    this.cwd = cwd || this.opts.cwd;
    // A conversation saved before providers existed carries a bare model id —
    // normalize it so the picker reports the value it actually runs.
    const storedModel = stored?.modelId?.trim();
    if (storedModel) {
      this.modelId = resolveBuiltinModel(this.opts.settings, storedModel)?.value ?? storedModel;
    }
    this.messages = stored?.messages ?? [];
    this.compaction = stored?.compaction;
    // A fresh conversation has no measured window and no unreported pass.
    this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.lastMeasuredUsed = 0;
    // The spend rows count from where this conversation left off: a restored
    // session keeps the totals it had, or the panel would open the next turn by
    // handing back everything the session had already spent.
    this.sessionUsage = stored?.usage
      ? {
          inputTokens: stored.usage.inputTokens,
          outputTokens: stored.usage.outputTokens,
          cachedInputTokens: stored.usage.cachedInputTokens,
        }
      : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    this.thinkingOff = stored?.thinkingOff === true;
    // The override may be absent (follow the global setting), 0 (off here) or
    // a cap; the effective fuse is resolved from it right away so a report
    // right after boot is not off-by-the-settings-snapshot.
    this.thinkingLimitOverride = stored?.thinkingLimit;
    this.applyThinkingLimit(normalizeBuiltinThinkingLimit(this.opts.settings.builtinThinkingLimit));
    // Both boundaries outlive the process: a restart that forgot them would
    // send the noted results back verbatim and recompute the cut for nothing.
    this.maskUpTo = stored?.maskUpTo ?? 0;
    this.prunedFrom = stored?.prunedFrom ?? 0;
    this.offload = OffloadStore.forSession(this.opts.stateDir, sessionId);
    // Announce discovered skills before the boot reply: the harness merges them
    // into the composer's slash menu, exactly like a CLI agent's own list.
    const skills = await discoverSkills(this.opts.settings.builtinSkillPaths, this.cwd);
    const ru = this.opts.settings.locale === "ru";
    // The manual pass is offered next to the skills: the composer merges this
    // list into its slash menu, so `/compact` is discoverable without docs.
    const manual = {
      name: "compact",
      description: ru
        ? "Сжать историю сейчас (необязательно — на чём сфокусироваться)"
        : "Compact the history now (optionally: what to focus on)",
      inputHint: ru ? "[фокус]" : "[focus]",
    };
    // The wire switch sits next to the manual pass, not in the ⋯ menu: that
    // menu only shapes the prompt, this one stops the endpoint thinking at all.
    const wireThinking = {
      name: "thinking",
      description: ru
        ? "Выключить или включить проход размышлений у эндпоинта (по умолчанию — включён)"
        : "Turn the endpoint's thinking pass off or on (on by default)",
      inputHint: "on|off",
    };
    // The mid-think fuse: cuts a model call whose private reasoning runs long
    // and carries the turn on with a reminder — prompt-side, session-level.
    const thinkingLimit = {
      name: "thinking-limit",
      description: ru
        ? "Оборвать слишком длинные размышления шага и продолжить с напоминанием действовать"
        : "Cut a step's overlong private reasoning and continue with a reminder to act",
      inputHint: ru ? "on|off|<символы>" : "on|off|<chars>",
    };
    this.emitUpdate({
      sessionUpdate: "available_commands_update",
      commands: [
        manual,
        wireThinking,
        thinkingLimit,
        ...skills.map((s) => ({
          name: s.name,
          description: s.description || s.name,
          kind: "skill",
        })),
      ],
    });
    return { sessionId, configOptions: this.configOptions() };
  }

  private configOptions() {
    return [
      {
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: this.modelId,
        options: builtinModelOptions(this.opts.settings).map((o) => ({
          value: o.value,
          name: o.name,
          // Shown as its own right-hand column in pickers (OMP/Cursor show it too).
          provider: o.provider.name,
        })),
      },
      {
        id: "thinking",
        category: "model_config",
        name: "Thinking",
        type: "select",
        currentValue: this.thinking,
        options: [
          { value: "default", name: "Default" },
          { value: "low", name: "Low" },
          { value: "extra-low", name: "Extra low" },
        ],
      },
    ];
  }

  private persist(): void {
    if (!this.sessionId) return;
    saveBuiltinSession(this.opts.stateDir, this.sessionId, {
      version: 1,
      cwd: this.cwd,
      modelId: this.modelId,
      messages: this.messages,
      ...(this.thinkingOff ? { thinkingOff: true } : {}),
      ...(this.thinkingLimitOverride !== undefined ? { thinkingLimit: this.thinkingLimitOverride } : {}),
      ...(this.compaction ? { compaction: this.compaction } : {}),
      ...(this.maskUpTo > 0 ? { maskUpTo: this.maskUpTo } : {}),
      ...(this.prunedFrom > 0 ? { prunedFrom: this.prunedFrom } : {}),
      // The spend rows ride along: a restart must resume the session's totals,
      // not restart them from zero and make the panel's first update after the
      // reboot hand back what the session had already spent.
      ...(this.sessionUsage.inputTokens ||
      this.sessionUsage.outputTokens ||
      this.sessionUsage.cachedInputTokens
        ? { usage: { ...this.sessionUsage } }
        : {}),
    });
  }

  /**
   * Settings as of right now. The server hands a live getter alongside the boot
   * snapshot, so a knob turned in Settings reaches this chat on its next turn
   * instead of waiting for a new one.
   */
  private async settings(): Promise<AppSettings> {
    if (!this.opts.settingsProvider) return this.opts.settings;
    try {
      return await this.opts.settingsProvider();
    } catch {
      return this.opts.settings;
    }
  }

  /**
   * The fuse as it stands now: this chat's override, else the global
   * `builtinThinkingLimit`. Called wherever live settings are read — the
   * turn, the subagents' bridge and the report all read `thinkingLimit`.
   */
  private applyThinkingLimit(global: number): void {
    this.thinkingLimit = this.thinkingLimitOverride ?? normalizeBuiltinThinkingLimit(global);
  }

  private emitUpdate(update: Record<string, unknown>): void {
    if (this.stopping || !this.out) return;
    this.decorateUpdate(update);
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  /**
   * Single funnel for every ACP update. Subagent additions ride here so the
   * loop itself stays untouched: the `task` call gets a headline ("task:
   * explore: …") for its card, the harness gets the child's report on the
   * tool's terminal update, and the child's spend joins the session's totals
   * (the harness overwrites — never accumulates — usage per update).
   */
  private decorateUpdate(update: Record<string, unknown>): void {
    if (update.sessionUpdate === "usage_update") {
      const used = Number(update.used ?? 0) || 0;
      if (used > 0) this.lastMeasuredUsed = used;
      // The billing fields ride an increment: what THIS report adds — the call
      // a step just measured, the part of a turn's bill its steps did not
      // already report, a compaction pass. Fold it in and put the session's
      // totals on the wire: the harness keeps the latest update verbatim, so a
      // snapshot scoped to whatever happened last is what made the panel's
      // in/out rows jump backwards mid-run — a session-scoped one only grows.
      const usage = this.sessionUsage;
      usage.inputTokens += Number(update.inputTokens ?? 0) || 0;
      usage.outputTokens += Number(update.outputTokens ?? 0) || 0;
      usage.cachedInputTokens += Number(update.cachedInputTokens ?? 0) || 0;
      const bridge = this.activeSubagents;
      if (bridge) {
        const keys = ["inputTokens", "outputTokens", "cachedInputTokens"] as const;
        for (const key of keys) {
          const seen = Number(bridge.usage[key] ?? 0) || 0;
          const newMoney = Math.max(0, seen - this.bridgeReported[key]);
          this.bridgeReported[key] += newMoney;
          usage[key] += newMoney;
        }
      }
      update.inputTokens = usage.inputTokens;
      update.outputTokens = usage.outputTokens;
      update.cachedInputTokens = usage.cachedInputTokens;
      return;
    }
    const bridge = this.activeSubagents;
    if (!bridge) return;
    if (update.sessionUpdate === "tool_call" && update.toolName === "task") {
      const input = (update.rawInput ?? {}) as {
        agent?: unknown;
        system_prompt?: unknown;
        prompt?: unknown;
      };
      const label =
        typeof input.agent === "string" && input.agent.trim()
          ? input.agent.trim()
          : typeof input.system_prompt === "string" && input.system_prompt.trim()
            ? "ad-hoc"
            : "task";
      const brief = String(input.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      update.title = `task: ${label}${brief ? `: ${brief}` : ""}`;
      return;
    }
    if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
      const report = bridge.results.get(String(update.toolCallId ?? ""));
      if (report !== undefined) {
        update.result = report;
        bridge.results.delete(String(update.toolCallId ?? ""));
      }
    }
  }

  /** Delegates the call to the harness so `permissionPolicy` applies to us. */
  private async askPermission(toolCall: {
    title: string;
    kind: string;
    input: Record<string, unknown>;
  }): Promise<void> {
    const res = await this.rpc.request<{ outcome?: { outcome?: string; optionId?: string } }>(
      "session/request_permission",
      {
        sessionId: this.sessionId,
        toolCall: { title: toolCall.title, kind: toolCall.kind, input: toolCall.input },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Разрешить один раз" },
          { optionId: "reject_once", kind: "reject_once", name: "Запретить" },
        ],
      },
    );
    const outcome = res?.outcome;
    if (outcome?.outcome !== "selected" || !/^allow/i.test(outcome.optionId ?? "")) {
      throw new Error(`Операция отклонена: ${toolCall.title}`);
    }
  }

  // ── Context window ────────────────────────────────────────────────────────

  /**
   * Endpoint client for one selection. Rebuilt per call so `{{sessionId}}`
   * resolves to the session that is asking.
   *
   * No cache markers go into the request: the `/chat/completions` endpoints this
   * agent talks to cache a matching prefix on their own (OpenAI, DeepSeek,
   * Gemini and most relays). What they need from us is the other half — a prefix
   * that does not change for no reason, which the pinned mask, the stable
   * offload ids and the carried-over digest provide.
   */
  private endpointFor(selection: BuiltinModelSelection) {
    return builtinEndpoint(
      selection.provider,
      this.sessionId,
      this.thinkingOff ? THINKING_DISABLED_BODY : undefined,
    );
  }

  /**
   * Manual `/compact [focus]`: the pass the threshold would run, with the line
   * lowered so it fires now, and an optional focus line the digest must carry.
   */
  private async compactNow(
    selection: BuiltinModelSelection,
    focus: string,
  ): Promise<{ stopReason: string }> {
    const endpoint = this.endpointFor(selection);
    const abort = new AbortController();
    this.abort = abort;
    try {
      const before = this.compaction?.covered ?? 0;
      // This prompt's own accumulator: its pass bill has nowhere else to go —
      // there is no turn after it to carry the report.
      this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      await this.promptHistory({
        contextWindow: selection.contextWindow,
        model: endpoint.chatModel(selection.modelId),
        abortSignal: abort.signal,
        // The system prompt of the last turn, so a manual pass rides on the
        // prefix that turn already warmed. A session opened on `/compact` has
        // none — and nothing to fold either.
        system: this.lastSystem,
        tools: this.lastTools,
        force: focus,
        manual: true,
      });
      const after = this.compaction?.covered ?? 0;
      // A pass that folded something reports itself through the compaction row
      // (see `emitCompaction`); only "nothing to squeeze" still needs words.
      if (after <= before) {
        const ru = this.opts.settings.locale === "ru";
        this.emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: ru
              ? "Сжимать нечего: история и так ниже линии."
              : "Nothing to compact: the history is already below the line.",
          },
        });
      }
      // The pass's bill is in the session's totals already (see `ask`), but
      // totals only reach the panel through an update: the compaction row
      // prices only the digest's output, so without this one the pass would
      // stay unread until the next turn. A provider that reported no usage for
      // it leaves the panel on the previous figures, as before.
      const pending = this.pendingUsage;
      if (pending.inputTokens || pending.outputTokens || pending.cachedInputTokens) {
        this.emitUpdate({
          sessionUpdate: "usage_update",
          size: selection.contextWindow,
          // The squeezed size is an estimate until the next call measures it:
          // the chip keeps the last number the provider itself put on this
          // window, and the next turn replaces it with the real one.
          used:
            this.lastMeasuredUsed > 0
              ? this.lastMeasuredUsed
              : pending.inputTokens + pending.outputTokens,
        });
        this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      }
      return { stopReason: "end_turn" };
    } finally {
      this.abort = null;
    }
  }

  /**
   * `/thinking off|on` (bare = toggle): the wire switch that stops the endpoint
   * from running its thinking pass at all — the thing that actually costs those
   * reasoning tokens. Separate from the prompt-side Default/Low the ⋯ menu
   * picks: that one only asks the model to be brief, it cannot stop it.
   */
  private setWireThinking(arg: string): { stopReason: string } {
    const ru = this.opts.settings.locale === "ru";
    const word = arg.trim().toLowerCase();
    const on = word === "on" || word === "true" || word === "1" || word === "вкл";
    const off = word === "off" || word === "false" || word === "0" || word === "выкл";
    if (word && !on && !off) {
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: ru
            ? "Не понял аргумент. `/thinking off` выключает проход размышлений, `/thinking on` включает, `/thinking` без аргумента переключает."
            : "Did not understand the argument. `/thinking off` disables the thinking pass, `/thinking on` enables it, bare `/thinking` toggles.",
        },
      });
      return { stopReason: "end_turn" };
    }
    this.thinkingOff = word ? off : !this.thinkingOff;
    this.persist();
    this.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: this.thinkingOff
          ? ru
            ? 'Thinking выключен: запросы уходят с `thinking: {"type": "disabled"}`. Включить — `/thinking on`.'
            : 'Thinking is off: requests go out with `thinking: {"type": "disabled"}`. Turn it back on with `/thinking on`.'
          : ru
            ? "Thinking включён: эндпоинт снова решает сам, думать ли. Выключить — `/thinking off`."
            : "Thinking is on: the endpoint decides again whether to think. Turn it off with `/thinking off`.",
      },
    });
    return { stopReason: "end_turn" };
  }

  /**
   * `/thinking-limit [on|off|<chars>]` (bare = report): the mid-think fuse.
   * Past the threshold a model call is cut while it is still only thinking,
   * the reasoning it produced is folded into the history, and the turn
   * continues with a reminder to act. Sets this chat's override — `off` pins
   * it off even when the global setting arms the fuse, `on` hands control
   * back to the global setting (or the 3000-char default when that is off).
   */
  private async setThinkingLimit(arg: string): Promise<{ stopReason: string }> {
    const ru = this.opts.settings.locale === "ru";
    const global = normalizeBuiltinThinkingLimit((await this.settings()).builtinThinkingLimit);
    const word = arg.trim().toLowerCase();
    const on = word === "on" || word === "true" || word === "1" || word === "вкл";
    const off = word === "off" || word === "false" || word === "0" || word === "выкл";
    const report = () => {
      // The base line states the effective fuse; only the provenance varies.
      const source =
        this.thinkingLimit > 0 && this.thinkingLimitOverride === undefined
          ? ru
            ? " Порог взят из глобальной настройки."
            : " The cap comes from the global setting."
          : this.thinkingLimit === 0 && this.thinkingLimitOverride === 0 && global > 0
            ? ru
              ? ` В этом чате он выключен вручную, хотя глобальная настройка: ${global} символов.`
              : ` Off in this chat by choice, while the global setting is ${global} chars.`
            : "";
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            (this.thinkingLimit > 0
              ? ru
                ? `Предохранитель включён: размышления шага длиннее ${this.thinkingLimit} символов обрываются с напоминанием действовать. Выключить — \`/thinking-limit off\`, новый порог — \`/thinking-limit <символы>\`.`
                : `Fuse is on: a step's reasoning past ${this.thinkingLimit} chars is cut and the model is reminded to act. Turn off with \`/thinking-limit off\`, set a new cap with \`/thinking-limit <chars>\`.`
              : ru
                ? `Предохранитель выключен: размышления ничем не ограничены. Включить — \`/thinking-limit on\` (${
                    global > 0 ? "глобальная настройка" : "3000 символов"
                  }), свой порог — \`/thinking-limit <символы>\`.`
                : `Fuse is off: reasoning is unlimited. Turn it on with \`/thinking-limit on\` (${
                    global > 0 ? "follows the global setting" : "3000 chars"
                  }) or set your own with \`/thinking-limit <chars>\`.`) +
            source,
        },
      });
      return { stopReason: "end_turn" };
    };
    if (!word) return report();
    if (word && !on && !off && !/^\d+$/.test(word)) {
      this.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: ru
            ? "Не понял аргумент. `/thinking-limit on` включает (3000 символов), `/thinking-limit off` выключает, `/thinking-limit 1500` ставит свой порог."
            : "Did not understand the argument. `/thinking-limit on` enables the fuse (3000 chars), `/thinking-limit off` disables it, `/thinking-limit 1500` sets your own cap.",
        },
      });
      return { stopReason: "end_turn" };
    }
    this.thinkingLimitOverride = off
      ? 0
      : on
        ? global > 0
          ? undefined
          : THINKING_LIMIT_DEFAULT_CHARS
        : Number(word);
    this.applyThinkingLimit(global);
    this.persist();
    return report();
  }

  /**
   * The prompt view of the stored history — the only thing these settings
   * shape. Tiers in the order of what they cost: archive a bulky result so it
   * can be read back, mask the results of tools that can simply be called again
   * (no model call at all), then, per `builtinContextMode`, digest the oldest
   * turns with one model call or drop them outright. `this.messages` keeps the
   * whole transcript either way, so a pass never destroys what the chat shows.
   */
  private async promptHistory(opts: {
    contextWindow: number;
    model: TurnModel;
    abortSignal: AbortSignal;
    /** The system prompt this turn sends; empty for a session opened on `/compact`. */
    system: string;
    /** The declarations this turn sends — part of the prefix the provider caches. */
    tools?: ToolSet;
    /** Manual `/compact` — run a pass whatever the window says. */
    force?: string;
    /** Manual `/compact` — the row says a human asked for this pass. */
    manual?: boolean;
  }): Promise<ModelMessage[]> {
    const settings = await this.settings();
    const keepLastConfigured = settings.builtinPruneToolResultsKeepLast;
    // Tier 0: bulky results move to the session archive under a stable id and
    // reach the model as a citation it can read back — reversible, unlike a
    // mask, and deterministic per message, so a cached prefix survives it.
    const offloaded =
      settings.builtinOffloadToolResultTokens > 0 && this.offload
        ? offloadToolResults(this.messages, this.offload, settings.builtinOffloadToolResultTokens)
        : this.messages;
    // Tier 1: mask what can simply be called again. The boundary is pinned
    // between passes — advancing it every turn would rewrite the prefix and
    // throw away the provider's prompt cache for every later message.
    const keepLast = Math.max(0, offloaded.length - this.maskUpTo);
    // A thinking model reads its observation history, and hard masking costs it
    // ~10% of its solve rate (arXiv 2508.21433): leave it alone when reasoning
    // is present, unless the setting says otherwise.
    const skipMask =
      keepLastConfigured > 0 &&
      settings.builtinRespectReasoningHistory &&
      hasReasoning(offloaded);
    const view = skipMask
      ? offloaded
      : maskToolResults(offloaded, keepLast, settings.builtinPruneReasoning);
    const thresholdPercent = opts.force !== undefined ? 1 : settings.builtinCompactionThresholdPercent;
    if (settings.builtinContextMode === "off" && opts.force === undefined) return view;
    if (settings.builtinContextMode === "prune" && opts.force === undefined) {
      const line = opts.contextWindow * (settings.builtinCompactionThresholdPercent / 100);
      // Both boundaries are sticky and move together: the cut only when the kept
      // view outgrows the line again, the notes with it. Advancing them every
      // turn rewrote the head of every later request, and the provider charged
      // the whole view again for a turn that added a sentence.
      if (opts.contextWindow > 0 && estimateTokens(view.slice(this.prunedFrom)) > line) {
        const kept = pruneMessages(view, opts.contextWindow, settings.builtinCompactionThresholdPercent);
        this.advanceMaskBoundary(keepLastConfigured);
        this.prunedFrom = Math.max(this.prunedFrom, this.messages.length - kept.length);
        this.persist();
      }
      // The notes this turn's boundary stands for, cut at the stored index —
      // and cut again after them, unlike the pass path, which keeps the digest
      // in front of the tail.
      const noted = skipMask
        ? this.messages
        : maskToolResults(this.messages, this.messages.length - this.maskUpTo, settings.builtinPruneReasoning);
      return noted.slice(this.prunedFrom);
    }
    const maxSummaryTokens = settings.builtinMaxSummaryTokens;
    /**
     * The instruction travels as the LAST message, after the very turns the pass
     * folds: the summariser's request is then a prefix of the request this turn
     * already sent — same system prompt, same digest, same head, same bytes —
     * and the provider serves that prefix from its prompt cache. Only these few
     * hundred tokens are new. A transcript of its own (flattened by
     * `renderTranscript`) shares nothing with the previous request and pays full
     * price for the head: tens of thousands of tokens on the pass that matters.
     */
    const instruction = (previousSummary: string | undefined, focus: string | undefined) =>
      (previousSummary
        ? "Не отвечай на переписку выше и не продолжай её. Ты обновляешь конспект диалога программиста с " +
          "агентом: первое сообщение переписки — прошлый конспект, дальше — новые ходы. Сохрани ВСЁ из " +
          "прошлого конспекта, добавь новые решения и прогресс, перенеси завершённое из «в работе» в " +
          "«сделано». Формат: Задача, Ограничения, Сделано, В работе, Заблокировано, Решения, Следующие " +
          "шаги, Важное. Сохраняй точные пути файлов, имена функций и тексты ошибок. Ответь только " +
          "конспектом, без вступлений."
        : "Не отвечай на переписку выше и не продолжай её. Сожми эту переписку в конспект для памяти " +
          "агента: сохрани исходную задачу и её ограничения, принятые решения, изменённые файлы с сутью " +
          "правок, выполненные команды и их результат, нерешённые проблемы. Формат: Задача, Ограничения, " +
          "Сделано, В работе, Заблокировано, Решения, Следующие шаги, Важное. Ответь только конспектом, " +
          "без вступлений. Инструменты не вызывай.") + (focus ? `\n\nДополнительный фокус: ${focus}` : "");
    /**
     * The turn's own declarations, with nothing to execute: the wire bytes are
     * what the provider renders ahead of the messages, and they must match the
     * turn's exactly for its cached prefix to cover this request. A model that
     * answers with a tool call anyway finds no executor here, so it cannot run
     * anything — the caller sees empty prose and asks again.
     */
    const declared = (tools: ToolSet | undefined): ToolSet | undefined => {
      if (!tools) return undefined;
      const out: ToolSet = {};
      for (const [name, tool] of Object.entries(tools)) {
        const { execute: _execute, ...declaration } = tool as { execute?: unknown };
        out[name] = declaration as ToolSet[string];
      }
      return out;
    };
    // Output tokens the summariser wrote for THIS pass — every ask it makes,
    // retries included. The bill rides the compaction row: a digest the reader
    // can see but cannot price is half a bill.
    let summaryOutputTokens = 0;
    const ask = async (delta: ModelMessage[], previousSummary?: string, focus?: string) => {
      const head: ModelMessage[] = [
        ...(previousSummary ? [digestMessage(previousSummary)] : []),
        ...delta,
      ];
      const tools = declared(opts.tools);
      // `tool_choice` stays at the provider default (`auto`): naming `none`
      // makes it drop the declarations from the prompt altogether, and the
      // request then shares nothing with the turn's (8188 vs 9690 tokens, 0%
      // cached against 99%).
      const call = async (last: string) => {
        const { text, usage } = await generateText({
          model: opts.model,
          ...(opts.system ? { system: opts.system } : {}),
          messages: [...head, { role: "user", content: last }],
          ...(tools ? { tools } : {}),
          abortSignal: opts.abortSignal,
          maxRetries: 1,
          // 0 = the setting says "no ceiling": the provider default applies.
          ...(maxSummaryTokens > 0 ? { maxOutputTokens: maxSummaryTokens } : {}),
        });
        summaryOutputTokens += Number(usage?.outputTokens ?? 0) || 0;
        // This call is part of the prompt's bill, but no turn's usage report
        // would ever contain it: it goes straight into the session's totals,
        // and the next `usage_update` reports them (see `decorateUpdate`).
        // `pendingUsage` keeps its own copy — `/compact` reads it to decide
        // whether the pass cost anything worth reporting.
        const inTokens = Number(usage?.inputTokens ?? 0) || 0;
        const outTokens = Number(usage?.outputTokens ?? 0) || 0;
        const cachedTokens = Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) || 0;
        this.pendingUsage.inputTokens += inTokens;
        this.pendingUsage.outputTokens += outTokens;
        this.pendingUsage.cachedInputTokens += cachedTokens;
        this.sessionUsage.inputTokens += inTokens;
        this.sessionUsage.outputTokens += outTokens;
        this.sessionUsage.cachedInputTokens += cachedTokens;
        return text;
      };
      const first = await call(instruction(previousSummary, focus));
      if (first.trim()) return first;
      // Nothing but a tool call came back: ask again on the same prefix (still
      // cached) with the line that leaves no room for one.
      return call(
        `${instruction(previousSummary, focus)}\n\nИнструменты не вызывай — ответь только текстом конспекта.`,
      );
    };
    const before = this.compaction?.covered ?? 0;
    // The "before" the row reports is the view this pass started from — digest
    // plus tail — not the stored transcript: the covered prefix has been out
    // of every request since the pass that wrote the digest.
    const tokensBefore = estimateTokens(promptView(view, this.compaction));
    const result = await compactHistory({
      messages: view,
      contextWindow: opts.contextWindow,
      thresholdPercent,
      // A forced pass fires at 1% so it fires at all; what it produces still has
      // to sit under the line the setting names, or it is a retelling.
      fitPercent: settings.builtinCompactionThresholdPercent,
      keepRecentPercent: settings.builtinKeepRecentPercent,
      state: this.compaction,
      summarize: (dropped) => ask(dropped, undefined, opts.force),
      update: (delta, previous) => ask(delta, previous, opts.force),
    });
    if (result.state && result.state.covered !== before) {
      console.warn(
        `[builtin] compacted messages ${before}..${result.state.covered} into a digest ` +
          `(${skipMask ? "masking skipped: reasoning history" : ""})`,
      );
      this.compaction = result.state;
      this.advanceMaskBoundary(keepLastConfigured);
      this.persist();
      this.emitCompaction({
        manual: opts.manual === true,
        coveredBefore: before,
        coveredAfter: result.state.covered,
        tokensBefore,
        tokensAfter: estimateTokens(result.messages),
        summary: result.state.summary,
        summaryOutputTokens,
      });
      // Tier 1 applies to the view this pass is about to send: the notes moved
      // with the digest, so this turn carries them from the start. Leaving them
      // to the next turn rewrites the tail once more — the same bytes charged a
      // second time, and the cached prefix broken for nothing.
      if (!skipMask) {
        const tail = this.messages.slice(result.state.covered);
        const prefix = result.messages.length - tail.length;
        // A pruned fallback is not the stored tail verbatim — leave it alone.
        if (prefix >= 0) {
          const keepFromEnd = Math.max(0, this.messages.length - this.maskUpTo);
          return [
            ...result.messages.slice(0, prefix),
            ...maskToolResults(tail, keepFromEnd, settings.builtinPruneReasoning),
          ];
        }
      }
    }
    return result.messages;
  }

  /**
   * The pass, reported to the chat: a squeeze that happens silently is a bill
   * the reader cannot explain. Costs, sizes and the digest itself ride on the
   * update so the row can stand on its own, outside the turn's work.
   */
  private emitCompaction(info: {
    manual: boolean;
    coveredBefore: number;
    coveredAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    summary: string;
    /** Output tokens spent writing the digest; absent when the provider reports none. */
    summaryOutputTokens: number;
  }): void {
    this.emitUpdate({
      sessionUpdate: "compaction",
      manual: info.manual,
      coveredBefore: info.coveredBefore,
      coveredAfter: info.coveredAfter,
      tokensBefore: info.tokensBefore,
      tokensAfter: info.tokensAfter,
      summary: info.summary,
      // 0 means "the provider did not say", not "free": the row omits it and
      // the chat shows an unknown instead of a confident zero.
      ...(info.summaryOutputTokens > 0 ? { summaryOutputTokens: info.summaryOutputTokens } : {}),
    });
  }

  /**
   * Move the mask boundary to `messages.length - keepLast`. It only ever moves
   * forward and only when a pass already rewrote the prompt, so masking never
   * costs a cache hit on its own.
   */
  private advanceMaskBoundary(keepLastConfigured: number): void {
    if (!(keepLastConfigured > 0)) return;
    this.maskUpTo = Math.max(this.maskUpTo, Math.max(0, this.messages.length - keepLastConfigured));
  }

  // ── The turn ──────────────────────────────────────────────────────────────

  private async prompt(params: Record<string, unknown>): Promise<{ stopReason: string }> {
    if (!this.sessionId) throw new Error("session/new не был вызван");
    // Fail before the message is recorded: a retry after fixing Settings must
    // not stack duplicate user turns in the stored history.
    if (!hasBuiltinEndpoint(this.opts.settings)) {
      throw new Error("Не задан адрес встроенного агента — Настройки → Встроенный агент.");
    }
    if (!this.modelId) {
      throw new Error("Не выбрана модель встроенного агента — Настройки → Встроенный агент.");
    }
    const selection = resolveBuiltinModel(this.opts.settings, this.modelId);
    if (!selection) {
      throw new Error(
        `Модель "${this.modelId}" не найдена в настройках встроенного агента — Настройки → Встроенный агент.`,
      );
    }
    // `/compact [focus]` shapes the prompt view instead of asking the model
    // anything — it must not be recorded as a user turn.
    const manual = /^\/compact(?:\s+([\s\S]*))?$/.exec(promptText(params.prompt).trim());
    if (manual) return this.compactNow(selection, (manual[1] ?? "").trim());
    // `/thinking [on|off]` flips the wire switch: also a command, never a turn.
    const thinkingArg = THINKING_COMMAND_RE.exec(promptText(params.prompt).trim());
    if (thinkingArg) return this.setWireThinking(thinkingArg[1] ?? "");
    // `/thinking-limit [on|off|<chars>]` arms or disarms the mid-think fuse.
    const limitArg = THINKING_LIMIT_COMMAND_RE.exec(promptText(params.prompt).trim());
    if (limitArg) return this.setThinkingLimit(limitArg[1] ?? "");
    const skills = await discoverSkills(this.opts.settings.builtinSkillPaths, this.cwd);
    // An explicit `/name` message is rewritten into the skill's body plus the
    // request before it is recorded, so the stored history carries what the
    // model actually saw and a re-run expands identically.
    const promptParts = params.prompt;
    const expanded = await expandSkillInvocation(promptText(promptParts), skills);
    this.messages.push(userContent(expanded ? [{ type: "text", text: expanded }] : promptParts));
    this.persist();
    // A steer aimed at an earlier turn must not ride into this one.
    this.settleSteers(false);

    const live = await this.settings();
    // The fuse follows this chat's override, else the global setting — a knob
    // turned in Settings reaches this turn instead of a new session.
    this.applyThinkingLimit(normalizeBuiltinThinkingLimit(live.builtinThinkingLimit));
    const { contextWindow } = selection;
    const abort = new AbortController();
    this.abort = abort;
    const { tools: mcpEntries, warnings } = await this.mcp.ensure();
    for (const warning of warnings) console.warn(`[builtin] MCP ${warning}`);
    const ask = (toolCall: {
      title: string;
      kind: string;
      input: Record<string, unknown>;
    }) => this.askPermission(toolCall);
    try {
      const endpoint = this.endpointFor(selection);
      const offered = mcpEntries.filter((entry) => this.mode === "agent" || entry.readOnly);
      // One bridge per prompt: slots and the usage accumulator must span the
      // turn and its wrap-up continuation.
      // Children run on their own model when one is configured — a fresh
      // endpoint for that provider — and on the session's model otherwise.
      const subagentsEnabled = this.opts.settings.builtinSubagents?.enabled === true;
      const childChoice = subagentsEnabled
        ? subagentModelChoice(this.opts.settings, selection)
        : null;
      if (childChoice?.fellBack) {
        console.warn(
          `[builtin] subagent model "${this.opts.settings.builtinSubagents?.model}" is not configured — children run on the session model`,
        );
      }
      const childModel =
        !childChoice || childChoice.selection.value === selection.value
          ? endpoint.chatModel(selection.modelId)
          : builtinEndpoint(
              childChoice.selection.provider,
              this.sessionId,
              this.thinkingOff ? THINKING_DISABLED_BODY : undefined,
            ).chatModel(childChoice.selection.modelId);
      const subagents = subagentsEnabled
        ? createSubagentsBridge({
            mode: this.mode,
            ask,
            model: childModel,
            extraSystem: THINKING_INSTRUCTIONS[this.thinking],
            // Children ruminate at the same prices: the parent's fuse binds them.
            reasoningLimitChars: this.thinkingLimit,
            contextWindow: childChoice?.selection.contextWindow ?? contextWindow,
            cwd: this.cwd,
            signal: abort.signal,
            settings: this.opts.settings.builtinSubagents,
            emit: (update: Record<string, unknown>) => this.emitUpdate(update),
            buildChildTools: (childAsk) =>
              createBuiltinTools({
                host: this.rpc,
                mode: this.mode,
                sessionId: this.sessionId,
                ask: childAsk,
              }),
          })
        : null;
      this.activeSubagents = subagents;
      // One usage accumulator per prompt, cleared where the bridge is built:
      // the compaction pass below and every turn of this prompt (retries and
      // continuations included) report into it, and a retry that runs another
      // pass keeps both passes' bills.
      this.pendingUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      // The new bridge's counter starts at zero, so the totals it feeds have
      // nothing counted yet.
      this.bridgeReported = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      // Built once for the whole turn: the summariser borrows this exact string
      // so its request starts where this turn's did (see `ask`), and a retried
      // attempt must not drift the prefix the first attempt already warmed.
      const system = systemPrompt(
        live.locale,
        this.cwd,
        this.mode,
        {
          servers: [...new Set(offered.map((entry) => entry.server))],
          tools: offered.map((entry) => entry.qualifiedName),
        },
        skills,
        live.builtinAllowOutsideCwd === true,
        [
          live.builtinExtraInstructions ?? "",
          THINKING_INSTRUCTIONS[this.thinking],
        ]
          .filter((part) => part.trim())
          .join("\n\n"),
      );
      this.lastSystem = system;
      // Built before the prompt for the same reason as the system prompt: the
      // tool declarations are rendered ahead of the messages, so the
      // summariser has to send the very same ones or its request stops being a
      // prefix of this turn's (measured: without them 0% of the head comes from
      // the provider's cache, with them 98%).
      const tools = {
        ...createBuiltinTools({
          host: this.rpc,
          mode: this.mode,
          sessionId: this.sessionId,
          ask,
          outsideCwd: live.builtinAllowOutsideCwd === true,
          subagents: subagents ?? undefined,
        }),
        ...mcpToolSet(offered, { readOnlyOnly: false, ask }),
      };
      this.lastTools = tools;
      const turn = async () =>
        runTurn({
          model: endpoint.chatModel(selection.modelId),
          system,
          messages: await this.promptHistory({
            contextWindow,
            model: endpoint.chatModel(selection.modelId),
            abortSignal: abort.signal,
            system,
            tools,
          }),
          tools,
          abortSignal: abort.signal,
          contextWindow,
          maxOutputTokens: live.builtinMaxOutputTokens,
          // The `/thinking-limit` fuse: past this many chars of one step's
          // private reasoning the call is cut and the turn carries on below.
          reasoningLimitChars: this.thinkingLimit,
          emit: (update) => this.emitUpdate(update),
          // `afterStep`: the host's mid-turn messages join the next model call
          // instead of waiting for this turn to end.
          takeSteer: () => this.takeSteers(),
        });
      // The folded messages sit where the model read them — mid-step, not at
      // the tail — so the stored history stays a truthful transcript. A failed
      // attempt is folded the same way: the retry then continues from what the
      // dead call had already produced instead of repeating that work.
      const keepResponse = (partial: TurnOutcome) => {
        const response = [...partial.response];
        for (const { at, message } of partial.injected ?? []) response.splice(at, 0, message);
        this.messages = [...this.messages, ...response];
        this.persist();
      };
      // A stream that dies mid-flight throws before any response message
      // exists, so the stored history is still exact and the same turn can
      // simply run again; one that dies after producing messages comes back as
      // an outcome carrying `failure`, and is folded before the retry.
      // A step the model cut short — stopped on reasoning alone, or capped
      // mid-answer — is not an answer. The turn runs on from what it produced,
      // and this line is what tells it to pick up there instead of reading its
      // own cut-off output as the end.
      const carryOn =
        live.locale === "ru"
          ? "Предыдущий ход оборвался, не дойдя до ответа. Продолжи с того места, " +
            "где остановился, — не начинай заново."
          : "The previous turn was cut off before you wrote an answer. Continue from " +
            "where you stopped — do not start over.";
      // A reasoning cut gets the reminder, not the generic nudge: the step's
      // thinking is already in the history (folded by `keepPartial`), so the
      // model resumes from its own conclusions with a push to act on them.
      const afterReasoningCut =
        live.locale === "ru"
          ? `Размышления на шаге превысили лимит в ${this.thinkingLimit} символов и были обрезаны — ` +
            "их начало сохранено выше. Не продолжай рассуждать: действуй прямо сейчас по тому, " +
            "что уже понял, — вызови инструмент или дай ответ."
          : `The step's reasoning exceeded the ${this.thinkingLimit}-char limit and was cut — ` +
            "its beginning is kept above. Do not keep thinking: act right now on what you " +
            "already know — call a tool or give the answer.";
      const retryOpts = {
        signal: abort.signal,
        attempts: live.builtinTurnRetryAttempts ?? MAX_TURN_ATTEMPTS,
        note: (message: string) =>
          this.emitUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message },
          }),
        // The outcome `runTurnWithRetry` gives back on exhaustion has already
        // been through `keepPartial` — folding it again would put a duplicate
        // of the last message into the history.
        keepPartial: (partial: TurnOutcome) => {
          folded = partial;
          keepResponse(partial);
        },
        continueAfter: (cut: TurnOutcome) => {
          const nudge = cut.reasoningLimitHit ? afterReasoningCut : carryOn;
          this.messages = [...this.messages, userContent([{ type: "text", text: nudge }])];
          this.persist();
        },
      };
      let folded: TurnOutcome | null = null;
      let outcome = await runTurnWithRetry(turn, retryOpts);
      if (outcome.reasoningLimitHit && !abort.signal.aborted) {
        // The fuse spent its continuations and the turn is still silent: on
        // this cap the model cannot finish a single step without being cut.
        // One last call with the fuse off — its thinking is already in the
        // history with the reminder, and an answer must reach the user.
        this.messages = [...this.messages, userContent([{ type: "text", text: afterReasoningCut }])];
        this.persist();
        const cap = this.thinkingLimit;
        this.thinkingLimit = 0;
        try {
          folded = null;
          outcome = await runTurnWithRetry(turn, retryOpts);
        } finally {
          this.thinkingLimit = cap;
        }
      }
      if (folded !== outcome) keepResponse(outcome);
      if (outcome.failure) throw outcome.failure;
      return { stopReason: outcome.stopReason };
    } finally {
      this.abort = null;
      this.activeSubagents = null;
      // Whatever a steer was still waiting on belongs to a turn that is over.
      this.settleSteers(false);
    }
  }

  /**
   * `session/steer`: fold text into the turn that is running right now. No live
   * turn means nothing to fold into — the host queues the message instead.
   */
  private steer(params: Record<string, unknown>): Promise<{ delivered: boolean }> {
    const text = typeof params.text === "string" ? params.text : promptText(params.prompt);
    if (!this.abort || !text.trim()) return Promise.resolve({ delivered: false });
    return new Promise((resolve) => {
      this.steers.push({ text, resolve: (delivered) => resolve({ delivered }) });
    });
  }

  /** Drain the pending mid-turn messages for the next model call. */
  private takeSteers(): Array<{ message: ModelMessage; ack: () => void }> {
    return this.steers.splice(0).map((entry) => ({
      message: userContent([{ type: "text", text: entry.text }]),
      // The message is part of a prompt only once the loop says so.
      ack: () => entry.resolve(true),
    }));
  }

  /** Answer everyone still waiting on a steer the turn never got to. */
  private settleSteers(delivered: boolean) {
    for (const entry of this.steers.splice(0)) entry.resolve(delivered);
  }
}

export function createBuiltinTransport(opts: InProcessAgentOptions): InProcessAgentTransport {
  return new BuiltinAgent(opts);
}
