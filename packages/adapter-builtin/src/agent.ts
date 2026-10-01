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
import { compactMessages, renderTranscript, runTurn } from "./loop.js";
import { McpManager, mcpToolSet, parseMcpServers } from "./mcp.js";
import { isValidSessionId, loadBuiltinSession, saveBuiltinSession } from "./store.js";
import { createBuiltinTools } from "./tools.js";

const AGENT_INFO = { name: "acpio-builtin", title: "Built-in agent", version: "0.1.0" };
const MODES: readonly string[] = ["agent", "plan", "ask"];

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
    "- Verify with the check the task names, once: if it fails, fix the code, never the check. " +
      "Stop as soon as it passes — no extra listings, re-reads or cleanup unless asked.",
    "- `bash` is a POSIX shell on every platform (Git Bash on Windows): pipes, `&&` and " +
      "single/double quotes behave like bash, and paths may use `/`. Prefer one direct command " +
      "(`sed`, `perl -pi`, a short `node -e` rewrite) over writing a helper script and debugging " +
      "it — every debug round is a wasted step.",
    `- ${scope}`,
    ...(mcp.tools.length
      ? [
          "",
          `MCP servers connected: ${mcp.servers.join(", ")}. Their tools are prefixed \`mcp__\`:`,
          mcp.tools.join(", "),
        ]
      : []),
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

  private openSession(sessionId: string, cwd: string, restore = false, mcpServers?: unknown) {
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
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
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
    this.messages.push(userContent(params.prompt));
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
      const outcome = await runTurn({
        model: endpoint.chatModel(selection.modelId),
        system: systemPrompt(this.opts.settings.locale, this.cwd, this.mode, {
          servers: [...new Set(offered.map((entry) => entry.server))],
          tools: offered.map((entry) => entry.qualifiedName),
        }),
        messages: await compactMessages({
          messages: this.messages,
          contextWindow,
          summarize: async (dropped) => {
            const { text } = await generateText({
              model: endpoint.chatModel(selection.modelId),
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
          ...createBuiltinTools({ host: this.rpc, mode: this.mode, ask }),
          ...mcpToolSet(offered, { readOnlyOnly: false, ask }),
        },
        abortSignal: abort.signal,
        contextWindow,
        emit: (update) => this.emitUpdate(update),
      });
      this.messages = [...this.messages, ...outcome.response];
      this.persist();
      if (outcome.failure) throw outcome.failure;
      return { stopReason: outcome.stopReason };
    } finally {
      this.abort = null;
    }
  }
}

export function createBuiltinTransport(opts: InProcessAgentOptions): InProcessAgentTransport {
  return new BuiltinAgent(opts);
}
