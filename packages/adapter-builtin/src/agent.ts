import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  AgentMode,
  InProcessAgentOptions,
  InProcessAgentTransport,
} from "@acpio/shared";
import { builtinProviderHeaders } from "@acpio/shared";
import { generateText, type ModelMessage } from "ai";
import {
  builtinModelOptions,
  hasBuiltinEndpoint,
  initialModelId,
  resolveBuiltinModel,
} from "./config.js";
import { createHostRpc } from "./host.js";
import {
  compactMessages,
  MAX_TURN_ATTEMPTS,
  renderTranscript,
  runTurn,
  runTurnWithRetry,
  WRAP_UP_EXTRA_STEPS,
  WRAP_UP_STEPS,
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
  subagents: { allowAdhoc: boolean } | null,
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
    ...(subagents
      ? [
          "",
          "Subagents: you can delegate work with the `task` tool — the subagent runs in this " +
            "working directory with its own context window, and only its final report is added to " +
            "this conversation. Spawn subagents for a broad multi-file survey, for several " +
            "independent investigations in parallel, or when the exploration would flood this " +
            "conversation with listings; do the work yourself when a couple of targeted reads " +
            "would do. Write the child's prompt as a complete task: the child sees nothing of " +
            "this conversation." + (subagents.allowAdhoc ? "" : " Only named subagents are available."),
        ]
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
  private messages: ModelMessage[] = [];
  private abort: AbortController | null = null;
  /** Set for the duration of one prompt: the subagent bridge, if enabled. */
  private activeSubagents: SubagentsBridge | null = null;
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
      case "session/cancel":
        this.abort?.abort();
        return {};
      case "session/set_mode": {
        const modeId = String(params.modeId ?? "");
        if (MODES.includes(modeId)) this.mode = modeId as AgentMode;
        return {};
      }
      case "session/set_config_option": {
        const value = String(params.value ?? "").trim();
        if (String(params.configId ?? "") === "model" && value) {
          const picked = resolveBuiltinModel(this.opts.settings, value);
          if (!picked) {
            throw new Error(
              `Модель "${value}" не найдена в настройках встроенного агента — Настройки → Встроенный агент.`,
            );
          }
          this.modelId = picked.value;
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
    // Announce discovered skills before the boot reply: the harness merges them
    // into the composer's slash menu, exactly like a CLI agent's own list.
    const skills = await discoverSkills(this.opts.settings.builtinSkillPaths, this.cwd);
    if (skills.length) {
      this.emitUpdate({
        sessionUpdate: "available_commands_update",
        commands: skills.map((s) => ({
          name: s.name,
          description: s.description || s.name,
          kind: "skill",
        })),
      });
    }
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
        })),
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
    });
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
   * tool's terminal update, and the child spend is folded into the turn usage
   * (the harness overwrites — never accumulates — usage per update).
   */
  private decorateUpdate(update: Record<string, unknown>): void {
    const bridge = this.activeSubagents;
    if (!bridge) return;
    if (update.sessionUpdate === "usage_update" && bridge.usage.totalTokens > 0) {
      update.inputTokens = (Number(update.inputTokens ?? 0) || 0) + bridge.usage.inputTokens;
      update.outputTokens = (Number(update.outputTokens ?? 0) || 0) + bridge.usage.outputTokens;
      update.cachedInputTokens =
        (Number(update.cachedInputTokens ?? 0) || 0) + bridge.usage.cachedInputTokens;
      return;
    }
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
    const skills = await discoverSkills(this.opts.settings.builtinSkillPaths, this.cwd);
    // An explicit `/name` message is rewritten into the skill's body plus the
    // request before it is recorded, so the stored history carries what the
    // model actually saw and a re-run expands identically.
    const promptParts = params.prompt;
    const expanded = await expandSkillInvocation(promptText(promptParts), skills);
    this.messages.push(userContent(expanded ? [{ type: "text", text: expanded }] : promptParts));
    this.persist();

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
      const endpoint = createOpenAICompatible({
        name: `builtin:${selection.provider.id}`,
        baseURL: selection.provider.url,
        apiKey: selection.provider.apiKey || undefined,
        // Most OpenAI-compatible servers only report usage when asked to.
        includeUsage: true,
        // The endpoint is rebuilt per turn, so `{{sessionId}}` resolves to
        // the session this turn belongs to.
        headers: builtinProviderHeaders(selection.provider.headers, this.sessionId),
      });
      const offered = mcpEntries.filter((entry) => this.mode === "agent" || entry.readOnly);
      // One bridge per prompt: slots and the usage accumulator must span the
      // turn and its wrap-up continuation.
      const model = endpoint.chatModel(selection.modelId);
      const subagents = this.opts.settings.builtinSubagents?.enabled
        ? createSubagentsBridge({
            mode: this.mode,
            ask,
            model,
            contextWindow,
            cwd: this.cwd,
            signal: abort.signal,
            settings: this.opts.settings.builtinSubagents,
            emit: (update: Record<string, unknown>) => this.emitUpdate(update),
            buildChildTools: (childAsk) =>
              createBuiltinTools({ host: this.rpc, mode: this.mode, ask: childAsk }),
          })
        : null;
      this.activeSubagents = subagents;
      const WRAP_UP_NOTE =
        "Ход превысил бюджет шагов. Завершай работу: проверь сделанное и дай итоговый ответ.";
      let wrapUpSent = false;
      const turnOptions = async (maxSteps: number) => ({
        model,
        system: systemPrompt(
          this.opts.settings.locale,
          this.cwd,
          this.mode,
          {
            servers: [...new Set(offered.map((entry) => entry.server))],
            tools: offered.map((entry) => entry.qualifiedName),
          },
          skills,
          subagents ? { allowAdhoc: this.opts.settings.builtinSubagents.allowAdhoc } : null,
        ),
        messages: await compactMessages({
          messages: this.messages,
          contextWindow,
          summarize: async (dropped) => {
            const { text } = await generateText({
              model,
              system:
                "Ты сжимаешь раннюю часть диалога программиста с агентом. Сохрани: исходную задачу и её " +
                "ограничения, принятые решения, изменённые файлы с сутью правок, выполненные команды и " +
                "их результат, нерешённые проблемы. Пиши на языке диалога, только конспект, без вступлений.",
              prompt: renderTranscript(dropped),
              abortSignal: abort.signal,
              maxRetries: 1,
            });
            console.warn(`[builtin] compacted ${dropped.length} messages into a summary`);
            return text;
          },
        }),
        tools: {
          ...createBuiltinTools({ host: this.rpc, mode: this.mode, ask, subagents: subagents ?? undefined }),
          ...mcpToolSet(offered, { readOnlyOnly: false, ask }),
        },
        abortSignal: abort.signal,
        contextWindow,
        emit: (update: Record<string, unknown>) => this.emitUpdate(update),
        maxSteps,
      });
      const turn = async () => {
        const outcome = await runTurn(
          await turnOptions(wrapUpSent ? WRAP_UP_EXTRA_STEPS : WRAP_UP_STEPS),
        );
        if (!outcome.stepBudgetHit || wrapUpSent || abort.signal.aborted) return outcome;
        // The turn ran out of steps with work in flight. Tell the model to
        // finish — visibly, and as a message it actually reads — and give it
        // one short continuation instead of letting an external kill decide
        // how the work ends.
        wrapUpSent = true;
        this.emitUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `[harness] ${WRAP_UP_NOTE}` },
        });
        this.messages = [...this.messages, ...outcome.response, userContent([{ type: "text", text: WRAP_UP_NOTE }])];
        this.persist();
        return runTurn(await turnOptions(WRAP_UP_EXTRA_STEPS));
      };
      // A stream that dies mid-flight throws before any response message
      // exists, so the stored history is still exact and the same turn can
      // simply run again. A failure that comes back with a resolved response
      // is not retried: those messages are already part of the history.
      const outcome = await runTurnWithRetry(turn, {
        signal: abort.signal,
        attempts: MAX_TURN_ATTEMPTS,
        note: (message) =>
          this.emitUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: message },
          }),
      });
      this.messages = [...this.messages, ...outcome.response];
      this.persist();
      if (outcome.failure) throw outcome.failure;
      return { stopReason: outcome.stopReason };
    } finally {
      this.abort = null;
      this.activeSubagents = null;
    }
  }
}

export function createBuiltinTransport(opts: InProcessAgentOptions): InProcessAgentTransport {
  return new BuiltinAgent(opts);
}
