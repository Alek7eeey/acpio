import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import readline from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  type InProcessAgentTransport,
  parseModelWire,
  resolveModelParamValue,
  modelParamFamily,
  modelIdFromValue,
  normalizeToolCallId,
  isProtocolPlaceholder,
  type AgentMode,
  type AgentProvider,
  type AcpUsage,
  type AppSettings,
  type HarnessAdapter,
  type McpServerConfig,
  isMcpServerAttached,
  isMcpServerConfigured,
  mcpCommandNeedsAbsolute,
  toAcpMcpServer,
} from "@acpio/shared";
import {
  appendDeepLog,
  rpcMethod,
  type DeepLogContext,
} from "../services/deepLogging.js";
import { adapterArgs, adapterCommand, adapterSetting } from "../adapters/registry.js";
import { globFiles, searchFiles, splitGlobScope } from "./agentFs.js";
import { DATA_DIR } from "../db/client.js";
import { offloadDir } from "@acpio/adapter-builtin";

const execFileAsync = promisify(execFile);

/** Built-in sessions, their stored conversations and their result archives. */
const BUILTIN_STATE_DIR = path.join(DATA_DIR, "agent-sessions");

// ACPIO_ACP_WIRE debug dumps fire once per frame (including token chunks), so a
// synchronous append would block the event loop for every chunk of a turn.
// Chain the appends instead: order stays per-process, and a failed write must
// never break the agent.
let wireChain = Promise.resolve();

function appendWireFrame(wirePath: string, dir: "in" | "out", msg: unknown) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), dir, msg })}\n`;
  wireChain = wireChain
    .then(() => fsp.appendFile(wirePath, line, "utf8"))
    .catch(() => {
      /* ignore */
    });
}

type JsonRpcId = number | string;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

type TerminalEntry = {
  id: string;
  proc: ChildProcess;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  byteLimit: number;
};

/**
 * The two ends the client drives: a spawned ACP CLI
 * (`ChildProcessWithoutNullStreams` fits structurally) or an in-process agent
 * wrapped into the same shape by {@link AcpClient.bindInProcess}.
 */
interface AgentPipe {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
}

export type AcpUpdate =
  | { kind: "agent_message_chunk"; text: string }
  | { kind: "agent_thought_chunk"; text: string }
  | { kind: "user_message_chunk"; text: string }
  | { kind: "tool_call"; toolCallId: string; title?: string; status?: string; raw: Record<string, unknown> }
  | { kind: "tool_call_update"; toolCallId: string; status?: string; raw: Record<string, unknown> }
  | { kind: "tool_call_content_chunk"; toolCallId: string; content: unknown; raw: Record<string, unknown> }
  | { kind: "plan"; raw: Record<string, unknown> }
  | { kind: "session_info"; raw: Record<string, unknown> }
  | { kind: "current_mode"; modeId: string; raw: Record<string, unknown> }
  | { kind: "config_options"; configOptions: ConfigOption[]; raw: Record<string, unknown> }
  | { kind: "available_commands"; raw: Record<string, unknown> }
  | { kind: "mixed_chunks"; thought?: string; text?: string }
  | { kind: "usage"; usage: AcpUsage; raw: Record<string, unknown> }
  | { kind: "compaction"; raw: Record<string, unknown> }
  | { kind: "other"; sessionUpdate: string; raw: Record<string, unknown> };

export type AcpRequest =
  | { kind: "permission"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "ask_question"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "create_plan"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "elicitation"; id: JsonRpcId; params: Record<string, unknown> };

/**
 * A JSON-RPC error response from the agent, with its structured `code`/`data`
 * kept: callers classify failures by `data` (OMP answers a prompt issued
 * during its own autonomous turn with `data.reason === "session_busy"`), not
 * by matching message text.
 */
export class AcpRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

export type ConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; provider?: string }>;
};

function normalizeConfigOptions(raw: ConfigOption[]): ConfigOption[] {
  return raw
    .map((opt) => {
      const id = String(opt.id ?? (opt as { configId?: string }).configId ?? "");
      const current =
        opt.currentValue == null || (opt.currentValue as unknown) === ""
          ? undefined
          : String(opt.currentValue);
      return {
        ...opt,
        id,
        category: opt.category ? String(opt.category) : undefined,
        type: opt.type ? String(opt.type) : undefined,
        currentValue: current,
        options: (opt.options ?? []).map((o) => ({
          value: String(o.value),
          name: String(o.name ?? o.value),
          ...(o.provider == null ? {} : { provider: String(o.provider) }),
        })),
      };
    })
    .filter((o) => o.id);
}

export function findModelConfigOption(options: ConfigOption[]): ConfigOption | undefined {
  // Prefer the canonical model select — never fast/effort/reasoning even if category is "model".
  return (
    options.find((o) => o.id === "model") ??
    options.find(
      (o) =>
        o.category === "model" &&
        !modelParamFamily(o.id) &&
        o.id !== "thought_level" &&
        o.id !== "variant",
    ) ??
    options.find((o) => /^model$/i.test(o.id))
  );
}

export function findModeConfigOption(options: ConfigOption[]): ConfigOption | undefined {
  return (
    options.find((o) => o.id === "mode" || o.id === "session_mode") ??
    options.find((o) => o.category === "mode")
  );
}

export type AgentModeOption = { value: string; name: string };

/** Modes from ACP `session/new` → `modes.availableModes` (Cursor/OMP/…) */
export function modesFromSessionState(raw: unknown): AgentModeOption[] {
  if (!raw || typeof raw !== "object") return [];
  const state = raw as {
    availableModes?: Array<{ id?: string; value?: string; name?: string }>;
    modes?: Array<{ id?: string; value?: string; name?: string }>;
  };
  const list = state.availableModes ?? state.modes ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => {
      const value = String(m.id ?? m.value ?? "").trim();
      if (!value) return null;
      return {
        value,
        name: String(m.name ?? value).trim() || value,
      };
    })
    .filter((m): m is AgentModeOption => Boolean(m));
}

/**
 * Modes the agent exposes for session/set_mode.
 * Prefer explicit `modes.availableModes` from session/new; fall back to configOptions;
 * then to the harness adapter's advertised defaults (Cursor: Agent/Plan/Ask).
 */
export function listAgentModes(
  options: ConfigOption[],
  defaultModes: AgentModeOption[],
  sessionModes?: AgentModeOption[],
): AgentModeOption[] {
  if (sessionModes && sessionModes.length > 0) {
    return sessionModes;
  }
  const opt = findModeConfigOption(options);
  if (opt?.options?.length) {
    return opt.options.map((o) => ({
      value: o.value,
      name: (o.name || o.value).trim() || o.value,
    }));
  }
  return [...defaultModes];
}

/** True when the agent exposes a real multi-mode switcher (not a lone default). */
export function isSwitchableModeList(modes: AgentModeOption[]): boolean {
  if (modes.length < 2) return false;
  if (modes.length === 1 && /^(default|normal|standard)$/i.test(modes[0]!.value)) return false;
  return true;
}

const SKIP_PARAM_IDS = new Set(["model", "mode", "session_mode"]);

export function listModelParamOptions(options: ConfigOption[]): ConfigOption[] {
  const modelOpt = findModelConfigOption(options);
  const filtered = options.filter((o) => {
    if (!o.id || SKIP_PARAM_IDS.has(o.id)) return false;
    if (o.category === "mode") return false;
    if (modelOpt && o.id === modelOpt.id) return false;
    if (o.id === "model") return false;

    const family = modelParamFamily(o.id);
    const known =
      family != null ||
      o.category === "thought_level" ||
      o.category === "model_config" ||
      /effort|thought|reason|fast|variant|context/i.test(o.id);

    const hasChoices = (o.options?.length ?? 0) > 0 || o.type === "boolean";
    if (!hasChoices) return false;

    // Known picker params always win (even if type is unusual).
    if (known) return true;

    // Do not invent Fast/Effort for OMP — only discrete extras with select/boolean.
    if (o.type && o.type !== "select" && o.type !== "boolean") return false;
    // Avoid treating unrelated session knobs as model params unless categorized.
    return o.category === "model_config" || o.category === "thought_level";
  });

  const rank = (id: string) => {
    const family = modelParamFamily(id);
    if (family === "fast") return 0;
    if (family === "effort") return 1;
    if (family === "context") return 2;
    return 50;
  };
  return filtered.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** Keep prior param options if a partial refresh omits them or returns empty choices. */
export function mergeConfigOptions(prev: ConfigOption[], next: ConfigOption[]): ConfigOption[] {
  if (!next.length) return prev;
  const byId = new Map(next.map((o) => [o.id, o]));
  for (const old of prev) {
    const fresh = byId.get(old.id);
    if (!fresh) {
      if (old.category === "mode" || old.id === "model") continue;
      // Drop effort-family when the agent truly removed it (e.g. Composer).
      // Only retain if this looks like a transient empty partial — handled below for empty options.
      continue;
    }
    if (
      old.id !== "model" &&
      (fresh.type === "select" || !fresh.type) &&
      (fresh.options?.length ?? 0) === 0 &&
      (old.options?.length ?? 0) > 0
    ) {
      byId.set(old.id, { ...fresh, options: old.options });
    }
  }
  return next.map((o) => byId.get(o.id) ?? o);
}

async function winKnownBins(command: string, adapter: HarnessAdapter): Promise<string[]> {
  const home = process.env.USERPROFILE ?? "";
  const local = process.env.LOCALAPPDATA ?? "";
  const appData = process.env.APPDATA ?? "";
  const names = [
    ...adapter.binaryNames.map((n) => `${n}.exe`),
    ...adapter.binaryNames.map((n) => `${n}.cmd`),
    `${command}.exe`,
    `${command}.cmd`,
  ];
  const dirs = [
    ...adapter.binaryDirs.map((d) => (local ? path.join(local, d) : "")),
    home ? path.join(home, ".local", "bin") : "",
    appData ? path.join(appData, "npm") : "",
  ].filter(Boolean);

  const candidates = dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
  const found = await Promise.all(
    candidates.map(async (full) => {
      try {
        await fsp.stat(full);
        return full;
      } catch {
        return "";
      }
    }),
  );
  return found.filter(Boolean);
}

export async function resolveCommand(
  command: string,
  adapter?: HarnessAdapter,
): Promise<{ cmd: string; shell: boolean }> {
  if (/\.(exe|cmd|bat)$/i.test(command) || command.includes("/") || command.includes("\\")) {
    return { cmd: command, shell: /\.(cmd|bat)$/i.test(command) };
  }

  if (process.platform === "win32") {
    const known = adapter ? await winKnownBins(command, adapter) : [];
    if (known[0]) {
      return { cmd: known[0], shell: /\.(cmd|bat)$/i.test(known[0]) };
    }

    try {
      const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
      const candidates = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const exe = candidates.find((p) => /\.exe$/i.test(p));
      const cmdShim = candidates.find((p) => /\.cmd$/i.test(p));
      const chosen = exe ?? cmdShim ?? candidates[0] ?? command;
      return { cmd: chosen, shell: /\.(cmd|bat)$/i.test(chosen) };
    } catch {
      return { cmd: command, shell: true };
    }
  }

  try {
    const { stdout } = await execFileAsync("which", [command]);
    return { cmd: stdout.trim() || command, shell: false };
  } catch {
    return { cmd: command, shell: false };
  }
}

/**
 * Rewrite a bare stdio MCP command to the absolute path of its shim. The ACP
 * spec requires `command` to be absolute, and OMP spawns client servers with
 * `Bun.spawn` (no shell): a bare `npx` / `mcp-gitea` never launches, so the
 * whole `session/new` fails and the chat loses every MCP tool. `where.exe`
 * answers `.exe` first; npm ships bare names as `.cmd` shims, which spawn
 * cannot execute — prefer the shim and let the agent's own resolver follow it.
 */
export async function resolveMcpStdioCommands(
  servers: McpServerConfig[],
  env: NodeJS.ProcessEnv,
): Promise<McpServerConfig[]> {
  if (!servers.some(mcpCommandNeedsAbsolute)) return servers;
  const out: McpServerConfig[] = [];
  for (const server of servers) {
    if (!mcpCommandNeedsAbsolute(server)) {
      out.push(server);
      continue;
    }
    const resolved = await resolveCommand(server.command!.trim());
    if (resolved.cmd !== server.command!.trim()) {
      console.log(`[mcp] stdio "${server.name}": ${server.command!.trim()} -> ${resolved.cmd}`);
    }
    out.push({ ...server, command: resolved.cmd });
  }
  return out;
}

function decodeProcessText(buf: Buffer): string {
  const asUtf8 = buf.toString("utf8");
  if (process.platform !== "win32") return asUtf8;
  // Windows cmd often prints OEM CP866; UTF-8 decode becomes mojibake.
  if (!/[^\u0000-\u007f]/.test(asUtf8) || !/�/.test(asUtf8)) return asUtf8;
  try {
    return new TextDecoder("ibm866").decode(buf);
  } catch {
    return asUtf8;
  }
}

/** Render a harness's install hint with the missing command interpolated. */
function installHintFor(adapter: HarnessAdapter, command: string): string {
  return adapter.installHint.replaceAll("{command}", command);
}

function looksLikeCommandNotFound(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("not recognized") ||
    t.includes("is not recognized") ||
    t.includes("не является") ||
    t.includes("не удается найти") ||
    t.includes("cannot find") ||
    /��/.test(text)
  );
}

export function buildAgentEnv(adapter: HarnessAdapter, settings: AppSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  // User-defined agents carry their own env (Settings → Connect).
  if (adapter.env) {
    for (const [key, value] of Object.entries(adapter.env)) {
      if (key) env[key] = value;
    }
  }
  const apiKey = adapter.apiKeyField ? adapterSetting(settings, adapter.apiKeyField) : undefined;
  if (adapter.envApiKeyName && typeof apiKey === "string" && apiKey) {
    env[adapter.envApiKeyName] = apiKey;
  }
  if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
  if (settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
  // Intentionally do not rewrite PATH on Windows. Prepending shim dirs (npm,
  // LOCALAPPDATA/omp, …) made OMP `/review` accept elicitation and immediately
  // return empty `end_turn` (native review never started). The harness binary is
  // already resolved to an absolute path before spawn.
  return env;
}

function joinTextPieces(pieces: string[]): string {
  // Concatenate as-is. Stream / content-block pieces already carry spaces;
  // auto-inserting between letter runs breaks Russian/English subword tokens.
  return pieces.filter(Boolean).join("");
}

const TEXTUAL_CONTENT_TYPES = new Set([
  "",
  "text",
  "input_text",
  "output_text",
  "thinking",
  "reasoning",
  "thought",
  "agent_thought",
]);

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return joinTextPieces(content.map((c) => extractText(c)));
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    // Never pull text out of tool results / resources / images — that leaks web
    // search dumps into the chat and glues fragments without spaces.
    if (type && !TEXTUAL_CONTENT_TYPES.has(type)) {
      return "";
    }
    if (typeof obj.delta === "string") return obj.delta;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.thinking === "string") return obj.thinking;
    if (typeof obj.reasoning === "string") return obj.reasoning;
    if (obj.content !== undefined) return extractText(obj.content);
  }
  return "";
}

/** Append streamed chunks as-is (spaces come from the model). */
function appendStreamText(prev: string, next: string): string {
  return joinTextPieces([prev, next]);
}

function contentBlockType(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "";
  return String((content as { type?: string }).type ?? "").toLowerCase();
}

function isThoughtContentType(type: string) {
  return /^(thought|thinking|reasoning|agent_thought)$/i.test(type);
}

/** Pull &lt;think&gt; / &lt;thinking&gt; blocks out of assistant text. */
export function splitInlineThinking(raw: string): { thought: string; text: string } {
  if (!raw) return { thought: "", text: "" };
  const thoughts: string[] = [];
  const text = raw
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_, body: string) => {
      thoughts.push(body.trim());
      return "";
    })
    .replace(/<thinking>([\s\S]*?)<\/thinking>/gi, (_, body: string) => {
      thoughts.push(body.trim());
      return "";
    })
    .replace(/◁think▷([\s\S]*?)◁\/think▷/gi, (_, body: string) => {
      thoughts.push(body.trim());
      return "";
    });
  return {
    thought: thoughts.filter(Boolean).join("\n\n"),
    // Keep leading spaces — stream tokens often arrive as " word", and stripping
    // them glues words together: "Hi!Everythingfine".
    text,
  };
}

// Streaming chunk kinds — logged per token, they would drown everything else.
const NOISY_UPDATE_KINDS: ReadonlySet<AcpUpdate["kind"]> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "mixed_chunks",
  "tool_call_content_chunk",
]);

/** Statuses that mean "the tool is still running" (mirrors sessionManager's
 *  STUCK_TURN_PART: a missing status reads as pending/active). */
const ACTIVE_TOOL_STATUS: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "running",
]);

function isActiveToolStatus(status: string | undefined): boolean {
  const s = String(status ?? "pending").toLowerCase();
  if (!s) return true;
  return ACTIVE_TOOL_STATUS.has(s);
}

/**
 * The one update a `session/load` replay cannot stand in for: the slash-command
 * list is session state the agent announces exactly once, at load. (It is not
 * history — nothing about it is replayed from the transcript.)
 */
const KINDS_ALLOWED_THROUGH_LOAD_REPLAY: ReadonlySet<AcpUpdate["kind"]> = new Set([
  "available_commands",
]);

/** One ACP `image` content block: base64 payload plus its IANA type. */
export interface PromptImageBlock {
  /** Base64 bytes — no `data:` prefix. */
  data: string;
  /** Full media type, e.g. `image/png`. */
  mimeType: string;
}

export class AcpClient extends EventEmitter {
  private proc: AgentPipe | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  /**
   * Agent requests (elicitation, permission, ask_question) the host has not
   * answered yet. The agent is blocked on the user, not on the network — the
   * idle ceiling must not fire while one of these is open, or a question the
   * user reads for five minutes gets killed mid-thought.
   */
  private awaitingReply = new Set<JsonRpcId>();
  /**
   * Tool calls announced by the agent but not yet closed. A tool that runs
   * a model request (`[js]` eval) can hold the wire quiet for many minutes
   * — that is work, not a hang — so the idle ceiling in {@link request}
   * must not kill the prompt while one is open, exactly like awaitingReply.
   * Cleared on prompt settle/start/stop so a stale open tool never exempts
   * the next prompt from its hang detector.
   */
  private activeTools = new Set<string>();
  private promptRequestId: JsonRpcId | null = null;
  private closed = false;
  private stderrBuf = "";
  private terminals = new Map<string, TerminalEntry>();
  sessionId: string | null = null;
  configOptions: ConfigOption[] = [];
  /** From session/new `modes.availableModes` when the agent provides it. */
  sessionModes: AgentModeOption[] = [];
  /** Capabilities advertised by the agent in `initialize`. */
  private capabilities: {
    loadSession?: boolean;
    sessionCapabilities?: { resume?: Record<string, unknown>; list?: unknown };
  } = {};
  /**
   * While true (a load-replaying harness), drop the replayed conversation from
   * session/update notifications — our DB already stores it. Session state the
   * agent only reports at load (its command list) still passes through.
   */
  private suppressUpdates = false;
  /** Last inbound ACP traffic (updates, replies, client method calls). */
  private lastActivityAt = Date.now();
  /** Optional host context attached to deep-log lines for this client. */
  logContext: DeepLogContext = {};

  /** OMP-style silent restore: agent supports `session/resume`. */
  get canResumeSession(): boolean {
    return Boolean(this.capabilities.sessionCapabilities?.resume);
  }

  /** Cursor-style restore: agent supports `session/load` (replays history). */
  get canLoadSession(): boolean {
    return this.capabilities.loadSession === true;
  }

  get canListSessions(): boolean {
    return this.capabilities.sessionCapabilities?.list != null;
  }

  constructor(
    private readonly adapter: HarnessAdapter,
    private readonly settings: AppSettings,
    private readonly cwd: string,
    private mode: AgentMode,
    /**
     * Re-reads settings for in-process agents, so a setting changed after this
     * client started still reaches the agent on its next turn. Absent = the
     * snapshot taken here is final (spawned CLIs read their env once anyway).
     */
    private readonly settingsProvider?: () => Promise<AppSettings>,
  ) {
    super();
  }

  /** Provider id (adapter id) — kept for logging/broadcast keys. */
  get provider(): AgentProvider {
    return this.adapter.id;
  }

  /** Exact file paths (outside the cwd) the agent may READ — user-attached files. */
  private extraReadFiles = new Set<string>();

  allowReadFile(absPath: string) {
    this.extraReadFiles.add(path.resolve(absPath));
  }

  get lastStderr() {
    return this.stderrBuf.slice(-4000);
  }

  private isConnected() {
    return !this.closed && Boolean(this.proc);
  }

  private bindPipeAgentProcess(
    child: ChildProcessWithoutNullStreams,
    commandName: string,
  ) {
    child.on("error", (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? installHintFor(this.adapter, commandName)
          : `spawn error: ${err.message}`;
      this.emit("log", msg);
      this.emit("output", `${msg}\n`);
      const wrapped = new Error(msg);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(wrapped);
      }
      this.pending.clear();
      this.awaitingReply.clear();
      this.activeTools.clear();
    });

    // A harness that dies mid-turn leaves writes racing its exit. Without a
    // listener the resulting EPIPE is an uncaught exception that takes the whole
    // server down; a dead agent is a per-session problem, not a host one.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      this.emit("log", `stdin write failed: ${err.code ?? err.message}`);
    });

    child.stderr.on("data", (buf: Buffer) => {
      const text = decodeProcessText(buf);
      this.stderrBuf += text;
      // Debug/diagnostic traffic only — user-visible output comes from ACP terminals.
      this.emit("log", text);
    });

    child.on("exit", (code, signal) => {
      const tail = this.stderrBuf.slice(-500);
      this.handleAgentExit(
        code,
        signal,
        looksLikeCommandNotFound(tail)
          ? installHintFor(this.adapter, commandName)
          : `ACP process exited (${code ?? signal})${tail ? `: ${tail}` : ""}`,
      );
    });

    this.proc = {
      stdin: child.stdin,
      stdout: child.stdout,
      kill: () => void child.kill(),
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onLine(line));
  }

  /** Terminal state shared by both transports: fail pending RPCs, drop host
   *  terminals, let the session layer drop its client. */
  private handleAgentExit(
    code: number | null,
    signal?: string | null,
    message?: string,
  ) {
    this.closed = true;
    const err = new Error(
      message ?? `ACP agent stopped (${code ?? signal ?? "closed"})`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.awaitingReply.clear();
    this.activeTools.clear();
    this.killAllTerminals();
    this.emit("exit", { code, signal });
  }

  /**
   * Drive an in-process agent through the same pipe a spawned CLI has.
   *
   * Lines are deferred a microtask in BOTH directions: `request()` writes the
   * frame before it registers its pending entry, so an agent answering inline
   * would find no waiter and the reply would be dropped. Microtasks keep frame
   * order within each direction.
   */
  private bindInProcess(transport: InProcessAgentTransport) {
    const stdin = new Writable({
      write: (chunk, _enc, cb) => {
        queueMicrotask(() => transport.write(String(chunk)));
        cb();
      },
    });
    const stdout = new PassThrough();
    transport.onLine((line) => queueMicrotask(() => stdout.write(`${line}\n`)));

    let stopped = false;
    transport.onClose((info) => {
      if (stopped) return;
      stopped = true;
      queueMicrotask(() => this.handleAgentExit(null, null, info?.message));
    });

    this.proc = {
      stdin,
      stdout,
      kill: () => transport.close(),
    };

    const rl = readline.createInterface({ input: stdout });
    rl.on("line", (line) => this.onLine(line));
  }

  async start(
    timeoutMs = 45000,
    opts?: {
      catalogOnly?: boolean;
      /** Reattach an existing agent session instead of creating a new one. */
      resume?: { sessionId: string; mode: "resume" | "load" };
      /** When loading a session our DB does not yet have, persist the replay. */
      ingestReplay?: boolean;
      /** Model applied at boot (defaults to settings.defaultModel). */
      model?: string;
      modelParams?: Record<string, string>;
      /** MCP servers for THIS session (global list filtered per chat). */
      mcpServers?: McpServerConfig[];
    },
  ): Promise<void> {
    const env = buildAgentEnv(this.adapter, this.settings);
    const cwd = this.cwd || process.cwd();
    // A missing cwd makes the child die with a generic "cannot find the path"
    // error that reads like a missing command — fail fast with a clear message.
    // Async stat: a dead network drive must not freeze the event loop.
    const cwdIsDir = await fsp
      .stat(cwd)
      .then((st) => st.isDirectory())
      .catch(() => false);
    if (!cwdIsDir) {
      throw new Error(`Рабочая папка не существует: ${cwd}. Выберите другую папку в настройках.`);
    }

    if (this.adapter.createTransport) {
      // In-process agent: no command to resolve and no process to supervise,
      // but the same ACP frames, the same host-side fs/terminal handlers.
      this.emit("log", `starting in-process agent cwd=${cwd}`);
      this.bindInProcess(
        this.adapter.createTransport({
          settings: this.settings,
          ...(this.settingsProvider ? { settingsProvider: this.settingsProvider } : {}),
          cwd,
          mode: this.mode,
          stateDir: BUILTIN_STATE_DIR,
        }),
      );
    } else {
      const commandName = adapterCommand(this.adapter, this.settings);
      const args = adapterArgs(this.adapter, this.settings);
      const resolved = await resolveCommand(commandName, this.adapter);
      const resolvedExists =
        resolved.cmd.includes("/") ||
        resolved.cmd.includes("\\") ||
        /\.(exe|cmd|bat)$/i.test(resolved.cmd)
          ? await fsp
              .stat(resolved.cmd)
              .then(() => true)
              .catch(() => false)
          : false;
      if (!resolvedExists && process.platform === "win32") {
        try {
          await execFileAsync("where.exe", [commandName], { windowsHide: true, env });
        } catch {
          throw new Error(installHintFor(this.adapter, commandName));
        }
      }

      this.emit("log", `starting ${resolved.cmd} ${args.join(" ")} cwd=${cwd}`);

      // Never shell-wrap .exe harnesses: `shell: true` on Windows can make OMP's
      // post-elicitation /review path exit with an empty end_turn.
      const child = spawn(resolved.cmd, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: resolved.shell && !/\.exe$/i.test(resolved.cmd),
        windowsHide: true,
      });
      this.bindPipeAgentProcess(child, commandName);
    }

    const boot = async () => {
      const initResult = (await this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          elicitation: { form: {} },
          // Harnesses with a parameterized model picker expose model params
          // (fast/effort/…) as separate config options.
          _meta: { parameterizedModelPicker: this.adapter.parameterizedModelPicker },
        },
        clientInfo: { name: "acpio", version: "0.1.0" },
      })) as {
        agentCapabilities?: {
          loadSession?: boolean;
          sessionCapabilities?: { resume?: Record<string, unknown>; list?: unknown };
        };
      };
      this.capabilities = initResult?.agentCapabilities ?? {};

      if (this.adapter.authenticateMethodId) {
        try {
          await this.send("authenticate", { methodId: this.adapter.authenticateMethodId });
        } catch (err) {
          this.emit("log", `authenticate skipped/failed: ${String(err)}`);
        }
      }
      // A caller-supplied list is already the chat's effective one — folder
      // overrides and chat switches resolved by `effectiveMcpServers` — so only
      // its transport fields are re-checked here. Testing `enabled` again would
      // undo a folder that switched a globally disabled server on. The fallback
      // (probe clients never pass a list) is the raw settings list and does
      // still need the global flag.
      const mcpServers = (await resolveMcpStdioCommands(
        (opts?.mcpServers ?? (this.settings.mcpServers ?? []).filter(isMcpServerAttached)).filter(
          isMcpServerConfigured,
        ),
        env,
      )).map(toAcpMcpServer);

      const resume = opts?.resume;
      let result: { sessionId?: string; configOptions?: ConfigOption[]; modes?: unknown };
      if (resume?.mode === "resume") {
        if (!this.canResumeSession) {
          throw new Error("Agent does not support session/resume");
        }
        this.sessionId = resume.sessionId;
        this.emit("log", `resuming session ${resume.sessionId} (session/resume)`);
        result = (await this.send("session/resume", {
          sessionId: resume.sessionId,
          cwd,
          mcpServers,
        })) as { configOptions?: ConfigOption[]; modes?: unknown };
      } else if (resume?.mode === "load") {
        if (!this.canLoadSession) {
          throw new Error("Agent does not support session/load");
        }
        this.sessionId = resume.sessionId;
        this.emit("log", `resuming session ${resume.sessionId} (session/load)`);
        // Load-style harnesses replay the whole stored conversation here; we
        // already have it in our DB, so swallow the notifications instead of
        // double-writing (adapter declares whether the replay must be muted).
        this.suppressUpdates = this.adapter.suppressReplayOnLoad && !opts?.ingestReplay;
        try {
          result = (await this.send("session/load", {
            sessionId: resume.sessionId,
            cwd,
            mcpServers,
          })) as { configOptions?: ConfigOption[]; modes?: unknown };
        } finally {
          this.suppressUpdates = false;
        }
      } else {
        result = (await this.send("session/new", { cwd, mcpServers })) as {
          sessionId?: string;
          configOptions?: ConfigOption[];
          modes?: unknown;
        };
        if (!result?.sessionId) {
          throw new Error("session/new did not return sessionId");
        }
        this.sessionId = result.sessionId;
      }

      this.configOptions = normalizeConfigOptions(result.configOptions ?? []);
      this.sessionModes = modesFromSessionState(result.modes);
      this.emit(
        "log",
        `configOptions: ${this.configOptions
          .map(
            (o) =>
              `${o.id}(${o.category ?? "-"}/${o.type ?? "-"}:${o.options?.length ?? 0})`,
          )
          .join(", ")}`,
      );
      if (this.sessionModes.length) {
        this.emit(
          "log",
          `modes: ${this.sessionModes.map((m) => m.value).join(", ")}`,
        );
      }

      try {
        if (!opts?.catalogOnly) {
          await this.applyModelSelection(
            opts?.model ?? this.settings.defaultModel,
            opts?.modelParams ?? this.settings.defaultModelParams,
          );
        }
      } catch (err) {
        this.emit("log", `set model failed: ${String(err)}`);
      }

      const modes = listAgentModes(this.configOptions, this.adapter.defaultModes, this.sessionModes);
      // Only apply when the agent actually supports this mode id (OMP has only "default").
      if (!opts?.catalogOnly && modes.some((m) => m.value === this.mode)) {
        try {
          await this.setMode(this.mode);
        } catch (err) {
          this.emit("log", `set_mode skipped: ${String(err)}`);
        }
      }
    };

    await Promise.race([
      boot(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `Таймаут запуска ACP (${timeoutMs}ms). Проверьте CLI и модель. ${this.stderrBuf.slice(-300)}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  }

  async listSessions(filter?: { cwd?: string }): Promise<
    Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: string }>
  > {
    if (!this.canListSessions) {
      throw new Error("Agent does not support session/list");
    }
    const out: Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: string }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page++) {
      const result = (await this.send("session/list", {
        ...(filter?.cwd ? { cwd: filter.cwd } : {}),
        ...(cursor ? { cursor } : {}),
      })) as {
        sessions?: Array<{ sessionId?: string; cwd?: string; title?: string; updatedAt?: string }>;
        nextCursor?: string;
      };
      for (const row of result?.sessions ?? []) {
        const sessionId = String(row.sessionId ?? "").trim();
        if (sessionId) out.push({ ...row, sessionId });
      }
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return out;
  }

  async setConfigOption(configId: string, value: string) {
    if (!this.sessionId) throw new Error("no session");
    const prev = this.configOptions;
    const result = (await this.send("session/set_config_option", {
      sessionId: this.sessionId,
      configId,
      value,
    })) as { configOptions?: ConfigOption[] };
    if (result?.configOptions) {
      const normalized = normalizeConfigOptions(result.configOptions);
      // Trust the agent when it drops a param (Composer has no Effort), but
      // don't accept empty option lists that would make Effort unclickable.
      this.configOptions = mergeConfigOptions(prev, normalized);
    }
    return result;
  }

  async setMode(modeId: string) {
    if (!this.sessionId) throw new Error("no session");
    const modes = listAgentModes(this.configOptions, this.adapter.defaultModes, this.sessionModes);
    if (modes.length && !modes.some((m) => m.value === modeId)) {
      throw new Error(`Unsupported mode: ${modeId}`);
    }
    try {
      await this.send("session/set_mode", {
        sessionId: this.sessionId,
        modeId,
      });
    } catch (err) {
      const modeOpt = findModeConfigOption(this.configOptions);
      if (!modeOpt) throw err;
      await this.setConfigOption(modeOpt.id, modeId);
    }
    if (modeId === "agent" || modeId === "plan" || modeId === "ask") {
      this.mode = modeId;
    }
  }

  /** Keep local mode in sync when the agent reports a mode change. */
  applyReportedMode(modeId: string) {
    if (modeId === "agent" || modeId === "plan" || modeId === "ask") {
      this.mode = modeId;
    }
  }

  applyConfigOptionsUpdate(options: ConfigOption[]) {
    this.configOptions = mergeConfigOptions(this.configOptions, options);
  }

  /** Apply base model + optional fast/effort/… for Cursor parameterized picker. */
  async applyModelSelection(model: string, params?: Record<string, string>) {
    const wire = model?.trim();
    if (!wire) return;
    const parsed = parseModelWire(wire);
    const modelOpt = findModelConfigOption(this.configOptions);
    const mergedParams = { ...parsed.params, ...(params ?? {}) };
    const modelId = modelOpt?.id ?? "model";
    const allowedModels = (modelOpt?.options ?? []).map((o) => o.value);
    const base = parsed.base || wire;

    // Cursor catalogs embed params in the model values ("composer-2.5[fast=true]")
    // and accept ONLY exact listed values. Prefer the exact listed wire for the
    // base with the user's params merged in; never send a bare base it rejects.
    let target: string;
    // A value the agent did not enumerate: it can still accept it (see below).
    let tentative = false;
    if (!allowedModels.length) {
      target = base;
    } else if (allowedModels.includes(wire)) {
      target = wire;
    } else if (allowedModels.includes(base)) {
      target = base;
    } else {
      const sameBase = allowedModels.find((v) => parseModelWire(v).base === base);
      if (sameBase) {
        const listedParams = parseModelWire(sameBase).params;
        const merged = { ...listedParams, ...mergedParams };
        const rebuilt = `${base}[${Object.entries(merged)
          .map(([k, v]) => `${k}=${v}`)
          .join(",")}]`;
        target = allowedModels.includes(rebuilt) ? rebuilt : sameBase;
      } else {
        // OMP catalogs one model under different provider prefixes (a stored
        // value may read "opencode-go/x" while the session list carries
        // "alibaba-token-plan/x"). Prefer the agent's own enumerated wire for
        // the same model id — the agent listed it, so it is accepted as is.
        const wantedId = modelIdFromValue(base);
        const sameId = wantedId
          ? allowedModels.find((v) => modelIdFromValue(parseModelWire(v).base) === wantedId)
          : undefined;
        if (sameId) {
          target = sameId;
        } else {
          // Nothing the agent enumerated matches: a value stored by an older
          // build, or one typed into settings. OMP rejects what its own list
          // omits ("Unknown ACP model"), but another harness may accept it —
          // send the requested value and let the agent decide; a rejection
          // (handled below) leaves its own model in place.
          target = wire;
          tentative = true;
        }
      }
    }
    try {
      await this.setConfigOption(modelId, target);
    } catch (err) {
      if (!tentative) throw err;
      this.emit(
        "log",
        `model skip: "${base}" was rejected by ${this.provider}: ${String(err)}`,
      );
      return;
    }
    this.emit("log", `model set to ${target}`);

    // Re-read after model change — Cursor swaps effort ↔ reasoning and may
    // drop Effort entirely (Composer). Only apply values the agent exposes.
    const freshParams = listModelParamOptions(this.configOptions);
    for (const opt of freshParams) {
      const allowed = opt.options?.map((o) => o.value);
      const value = resolveModelParamValue(opt.id, mergedParams, allowed);
      if (value === undefined || value === "") continue;
      if (allowed?.length && !allowed.includes(value)) continue;
      if (opt.currentValue != null && String(opt.currentValue) === value) continue;
      try {
        await this.setConfigOption(opt.id, value);
        this.emit("log", `${opt.id} set to ${value}`);
      } catch (err) {
        this.emit("log", `set ${opt.id} failed: ${String(err)}`);
      }
    }
  }

  async prompt(
    text: string,
    images: PromptImageBlock[] = [],
  ): Promise<{ stopReason?: string; raw: unknown }> {
    if (!this.sessionId) throw new Error("ACP session not started");
    // A second session/prompt while one is open cancels/queues the in-flight turn in OMP
    // (e.g. /review after elicitation). Never stack prompts on one client.
    if (this.promptRequestId != null) {
      throw new Error("ACP prompt already in flight");
    }
    // Each prompt starts with a clean tool ledger: entries left by a turn that
    // never closed its tools (or by an autonomous run between prompts) must
    // not pre-exempt this turn's idle ceiling.
    this.activeTools.clear();
    // Images ride as ACP `image` blocks after the text; the agent decides
    // whether its model can take them.
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const img of images) {
      prompt.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    const { id, promise } = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt,
    });
    this.promptRequestId = id;
    try {
      const raw = await promise;
      const stopReason =
        raw && typeof raw === "object" && "stopReason" in (raw as object)
          ? String((raw as { stopReason?: string }).stopReason ?? "")
          : undefined;
      return { stopReason, raw };
    } finally {
      if (this.promptRequestId === id) this.promptRequestId = null;
      // Turn over: an open tool the agent never closed must not leak into the
      // next prompt's exemption window.
      this.activeTools.clear();
    }
  }

  /**
   * Fold `text` into the turn this client is already running, without
   * cancelling it: a `midTurnSteering` agent puts it into the next model call,
   * so the model reads it right after the current tool step. ACP itself has no
   * steering — any other agent answers this method with an error (or never),
   * so the caller falls back to its own queue. Only asked of adapters whose
   * `midTurnSteering` says they can, and only for a prompt that is open.
   */
  async steer(text: string): Promise<boolean> {
    if (!this.sessionId || !this.isConnected() || !this.isPromptPending()) return false;
    if (!text.trim()) return false;
    try {
      const raw = await this.send("session/steer", { sessionId: this.sessionId, text });
      return (
        raw !== null &&
        typeof raw === "object" &&
        (raw as { delivered?: unknown }).delivered === true
      );
    } catch {
      // Unsupported method or a turn that ended while we were asking.
      return false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !this.isConnected()) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
    // Stop ends the turn: any request the agent was still waiting on is moot,
    // and a stale entry would exempt the NEXT prompt from its idle ceiling.
    this.awaitingReply.clear();
    this.activeTools.clear();
    // Child tools must stop too: host-side terminals spawned for this session
    // would otherwise keep running even after the agent's prompt is cancelled.
    this.killAllTerminals();
    // Unblock session/prompt immediately — agents may keep streaming briefly,
    // but the host must not stay stuck waiting for the prompt RPC.
    const id = this.promptRequestId;
    if (id == null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    this.promptRequestId = null;
    waiter.resolve({ stopReason: "cancelled" });
  }

  /** True while a `session/prompt` RPC is awaiting the agent's response. */
  isPromptPending(): boolean {
    return this.promptRequestId != null;
  }

  respond(id: JsonRpcId, result: unknown) {
    this.awaitingReply.delete(id);
    this.emit("log", `respond id=${String(id)}`);
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Send an arbitrary ACP request to the agent (`_omp/*` extension methods). */
  requestAgent<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.send(method, params) as Promise<T>;
  }

  respondError(id: JsonRpcId, message: string, code = -32000) {
    this.awaitingReply.delete(id);
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  dispose() {
    this.closed = true;
    this.awaitingReply.clear();
    this.activeTools.clear();
    this.killAllTerminals();
    try {
      this.proc?.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
  }

  private rootCwd() {
    return path.resolve(this.cwd || process.cwd());
  }

  /**
   * Whether the built-in agent's tools may leave the session cwd right now.
   * Refreshed per request (see {@link refreshOutsideCwd}), so the switch in
   * Settings → Built-in agent reaches a chat that is already running instead of
   * waiting for a restart — the same reason the transport re-reads its knobs
   * per turn.
   */
  private outsideCwdAllowed = false;

  /** Settings as of right now, falling back to the boot snapshot. */
  private async liveSettings(): Promise<AppSettings> {
    if (!this.settingsProvider) return this.settings;
    try {
      return await this.settingsProvider();
    } catch {
      return this.settings;
    }
  }

  private async refreshOutsideCwd(): Promise<void> {
    // Only the built-in agent has the switch: a spawned CLI keeps the workspace
    // boundary whatever a built-in setting says.
    if (this.adapter.id !== "builtin") {
      this.outsideCwdAllowed = false;
      return;
    }
    const settings = await this.liveSettings();
    this.outsideCwdAllowed = settings.builtinAllowOutsideCwd === true;
  }

  private assertInsideCwd(targetPath: string) {
    const root = this.rootCwd();
    const resolved = path.resolve(root, targetPath);
    // The switch is the user lifting the workspace boundary: every path the
    // agent names is then simply resolved against the cwd as before.
    if (this.outsideCwdAllowed) return resolved;
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      // The cwd in the message is the recovery path: a model aiming at a temp
      // dir retries once, inside the workspace, instead of guessing again.
      throw new Error(
        `Path outside session cwd: ${resolved}. The session cwd is ${root} — keep files, including scratch scripts, inside it.`,
      );
    }
    return resolved;
  }

  /** Reads may also target user-attached files outside the cwd (exact paths). */
  private assertReadablePath(targetPath: string) {
    const resolved = path.resolve(this.rootCwd(), targetPath);
    if (this.outsideCwdAllowed) return resolved;
    const rel = path.relative(this.rootCwd(), resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolved;
    const norm = (p: string) =>
      process.platform === "win32" ? p.toLowerCase() : p;
    if ([...this.extraReadFiles].some((f) => norm(f) === norm(resolved))) {
      return resolved;
    }
    // The built-in agent's own offload archive lives outside the cwd and is
    // read back with the ordinary `read` tool, so that one folder is readable —
    // for this session's files only.
    const archived = this.sessionId
      ? path.relative(offloadDir(BUILTIN_STATE_DIR, this.sessionId), resolved)
      : "";
    if (archived && !archived.startsWith("..") && !path.isAbsolute(archived)) {
      return resolved;
    }
    throw new Error(
      `Path outside session cwd: ${resolved}. The session cwd is ${this.rootCwd()} — keep files, including scratch scripts, inside it.`,
    );
  }

  private killTerminalEntry(entry: TerminalEntry) {
    try {
      entry.proc.kill();
    } catch {
      // ignore
    }
  }

  private killAllTerminals() {
    for (const [, t] of this.terminals) {
      this.killTerminalEntry(t);
    }
    this.terminals.clear();
  }

  private appendTerminalOutput(entry: TerminalEntry, chunk: string) {
    entry.output += chunk;
    if (entry.output.length > entry.byteLimit) {
      entry.truncated = true;
      entry.output = entry.output.slice(entry.output.length - entry.byteLimit);
    }
    if (chunk) this.emit("output", chunk);
  }

  private async handleFsRead(params: Record<string, unknown>) {
    const filePath = this.assertReadablePath(String(params.path ?? ""));
    const raw = await fsp.readFile(filePath, "utf8");
    // No window requested → return the bytes untouched: split/join would
    // normalize CRLF to LF, and an agent that edits afterwards would rewrite
    // every line ending in the file.
    if (Number(params.line ?? 1) <= 1 && params.limit == null) return { content: raw };
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, Number(params.line ?? 1) - 1);
    const limit = params.limit == null ? undefined : Number(params.limit);
    const sliced = limit == null ? lines.slice(start) : lines.slice(start, start + limit);
    // A slice hides the file's real length: the agent needs it to say "continue
    // with line N" against the right file, not against what it was sent.
    return { content: sliced.join("\n"), totalLines: lines.length };
  }

  private async handleFsWrite(params: Record<string, unknown>) {
    const filePath = this.assertInsideCwd(String(params.path ?? ""));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, String(params.content ?? ""), "utf8");
    return {};
  }

  /**
   * Agent-side `glob`. The pattern's leading folders are the search area: `src/`
   * with a `*.ts` tail walks `src`, and an absolute pattern walks the folder it
   * names — an absolute pattern used to match nothing, because the walk never
   * left the session cwd. A folder outside the cwd needs the Built-in agent's
   * workspace switch; paths come back cwd-relative inside it and absolute
   * outside, either form ready for `read`.
   */
  private async handleFsGlob(params: Record<string, unknown>) {
    const scope = splitGlobScope(String(params.pattern ?? params.glob ?? ""));
    return globFiles({
      root: scope.dir ? this.assertInsideCwd(scope.dir) : this.rootCwd(),
      base: this.rootCwd(),
      pattern: scope.pattern,
      nameOnly: scope.nameOnly,
      maxResults: params.max_results == null ? undefined : Number(params.max_results),
    });
  }

  /** Agent-side `grep`: a JavaScript regex over the workspace, line by line. */
  private async handleFsSearch(params: Record<string, unknown>) {
    const scope = String(params.path ?? "").trim();
    return searchFiles({
      root: this.rootCwd(),
      ...(scope ? { dir: this.assertInsideCwd(scope) } : {}),
      pattern: String(params.pattern ?? ""),
      ...(params.glob == null ? {} : { glob: String(params.glob) }),
      ignoreCase: params.ignore_case === true,
      maxResults: params.max_results == null ? undefined : Number(params.max_results),
    });
  }

  private handleTerminalCreate(params: Record<string, unknown>) {
    const command = String(params.command ?? "");
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const cwd =
      typeof params.cwd === "string" && params.cwd
        ? this.assertInsideCwd(params.cwd)
        : this.rootCwd();
    const byteLimit = Math.max(1024, Number(params.outputByteLimit ?? 1024 * 1024));
    const envList = Array.isArray(params.env) ? params.env : [];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const item of envList) {
      if (item && typeof item === "object") {
        const row = item as { name?: string; value?: string };
        if (row.name) env[row.name] = String(row.value ?? "");
      }
    }

    const id = randomUUID();
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry: TerminalEntry = {
      id,
      proc: child,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      byteLimit,
    };
    this.terminals.set(id, entry);
    const label = [command, ...args].filter(Boolean).join(" ").trim();
    if (label) this.emit("output", `\r\n\x1b[90m$ ${label}\x1b[0m\r\n`);
    this.emit("log", `terminal/create ${id} ${command} ${args.join(" ")}`.trim());

    child.stdout?.on("data", (buf: Buffer) =>
      this.appendTerminalOutput(entry, buf.toString("utf8")),
    );
    child.stderr?.on("data", (buf: Buffer) =>
      this.appendTerminalOutput(entry, buf.toString("utf8")),
    );
    child.on("error", (err) =>
      this.appendTerminalOutput(entry, `\n[spawn error] ${err.message}\n`),
    );
    child.on("close", (code, signal) => {
      entry.exitCode = code;
      entry.signal = signal;
    });

    return { terminalId: id };
  }

  private handleTerminalOutput(params: Record<string, unknown>) {
    const id = String(params.terminalId ?? "");
    const entry = this.terminals.get(id);
    if (!entry) throw new Error(`Unknown terminalId: ${id}`);
    return {
      output: entry.output,
      truncated: entry.truncated,
      exitStatus:
        entry.exitCode == null && entry.signal == null
          ? null
          : { exitCode: entry.exitCode, signal: entry.signal },
    };
  }

  private handleTerminalRelease(params: Record<string, unknown>) {
    const id = String(params.terminalId ?? "");
    const entry = this.terminals.get(id);
    if (entry) {
      this.killTerminalEntry(entry);
      this.terminals.delete(id);
    }
    return {};
  }

  private async handleTerminalWait(params: Record<string, unknown>) {
    const id = String(params.terminalId ?? "");
    const entry = this.terminals.get(id);
    if (!entry) throw new Error(`Unknown terminalId: ${id}`);
    if (entry.exitCode != null || entry.signal != null) {
      return { exitCode: entry.exitCode, signal: entry.signal };
    }
    const timeoutMs = Math.max(
      5_000,
      Math.min(Number(params.timeoutMs ?? 90_000) || 90_000, 300_000),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.killTerminalEntry(entry);
        this.appendTerminalOutput(entry, `\n[timeout after ${timeoutMs}ms]\n`);
        reject(new Error(`Terminal timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      entry.proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { exitCode: entry.exitCode, signal: entry.signal };
  }

  private handleTerminalKill(params: Record<string, unknown>) {
    const id = String(params.terminalId ?? "");
    const entry = this.terminals.get(id);
    if (entry) this.killTerminalEntry(entry);
    return {};
  }

  /** Client methods that carry a location the workspace switch can lift. */
  private static readonly PATH_METHODS = new Set([
    "fs/read_text_file",
    "fs/write_text_file",
    "fs/glob",
    "fs/search",
    "terminal/create",
  ]);

  private async handleClientMethod(method: string, params: Record<string, unknown>) {
    // A path-bearing call reads the switch first, so a Settings flip reaches
    // the very next tool call.
    if (AcpClient.PATH_METHODS.has(method)) await this.refreshOutsideCwd();
    switch (method) {
      case "fs/read_text_file":
        return this.handleFsRead(params);
      case "fs/write_text_file":
        return this.handleFsWrite(params);
      case "fs/glob":
        return this.handleFsGlob(params);
      case "fs/search":
        return this.handleFsSearch(params);
      case "terminal/create":
        return this.handleTerminalCreate(params);
      case "terminal/output":
        return this.handleTerminalOutput(params);
      case "terminal/release":
        return this.handleTerminalRelease(params);
      case "terminal/wait_for_exit":
        return this.handleTerminalWait(params);
      case "terminal/kill":
        return this.handleTerminalKill(params);
      default:
        throw new Error(`Unsupported client method: ${method}`);
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    return this.request(method, params).promise;
  }

  /**
   * Ceiling of silence for any single ACP request (prompt, tool call, …).
   * While the agent still sends traffic (session/update, etc.) the wait is
   * extended — only a quiet stretch of this length yields a timeout error.
   * Overridable in tests.
   */
  static requestTimeoutMs = 5 * 60_000;

  private markActivity() {
    this.lastActivityAt = Date.now();
  }

  private request(
    method: string,
    params: unknown,
  ): { id: JsonRpcId; promise: Promise<unknown> } {
    if (!this.isConnected()) {
      return {
        id: -1,
        promise: Promise.reject(new Error("ACP client is closed")),
      };
    }
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    this.markActivity();
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        method,
        timer: undefined as unknown as NodeJS.Timeout,
        resolve: (v) => {
          clearTimeout(pending.timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(pending.timer);
          reject(e);
        },
      };

      const armTimeout = () => {
        pending.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          // Agent still streaming / answering → do not kill an active turn.
          const idleMs = Date.now() - this.lastActivityAt;
          // An open elicitation/permission request park the agent on the user.
          // Waiting for a human is not a hang: keep the prompt alive so the
          // question stays answerable however long the user takes.
          const awaitingUser = this.awaitingReply.size > 0;
          // A tool the agent announced and has not closed yet may run for
          // minutes without one frame (a model eval inside `[js]`) — same
          // reasoning: silence with an open tool is work, not a hang.
          const runningTool = this.activeTools.size > 0;
          if (
            !this.closed &&
            this.isConnected() &&
            (awaitingUser || runningTool || idleMs < AcpClient.requestTimeoutMs)
          ) {
            this.emit(
              "log",
              awaitingUser
                ? `ACP "${method}" awaiting user input — not timing out`
                : runningTool
                  ? `ACP "${method}" tool in progress (${this.activeTools.size}) — extending wait`
                  : `ACP "${method}" still active (last traffic ${Math.round(idleMs / 1000)}s ago) — extending wait`,
            );
            armTimeout();
            return;
          }
          this.pending.delete(id);
          if (this.promptRequestId === id) this.promptRequestId = null;
          const timeoutSec = Math.round(AcpClient.requestTimeoutMs / 1000);
          const msg =
            `Таймаут ответа ACP (${timeoutSec}с) на "${method}". ` +
            `Агент не отвечает — возможно, завис внешний MCP-сервер или CLI.`;
          this.emit("log", msg);
          pending.reject(new Error(msg));
        }, AcpClient.requestTimeoutMs);
      };

      armTimeout();
      this.pending.set(id, pending);
    });
    return { id, promise };
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: unknown) {
    if (!this.proc?.stdin.writable) return;
    appendDeepLog({
      kind: "acp-out",
      direction: "out",
      method: rpcMethod(msg),
      ...this.logContext,
      data: msg,
    });
    const wirePath = process.env.ACPIO_ACP_WIRE;
    if (wirePath) appendWireFrame(wirePath, "out", msg);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.emit("log", `non-json: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Any parsed ACP traffic means the agent is still alive — keep long
    // requests (especially session/prompt) from timing out mid-stream.
    this.markActivity();

    appendDeepLog({
      kind: "acp-in",
      direction: "in",
      method: rpcMethod(msg),
      ...this.logContext,
      data: msg,
    });
    const wirePath = process.env.ACPIO_ACP_WIRE;
    if (wirePath) appendWireFrame(wirePath, "in", msg);

    if ("id" in msg && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const id = msg.id as JsonRpcId;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: unknown };
        waiter.reject(
          new AcpRpcError(
            err.message ?? "ACP error" + (err.data ? ` ${JSON.stringify(err.data)}` : ""),
            err.code,
            err.data,
          ),
        );
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    if (!method) return;

    if (method === "session/update") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? params) as Record<string, unknown>;
      const mapped = this.mapUpdate(update);
      // session/load replays the stored conversation, which our DB already
      // holds — swallowed so the turn is not written twice. The agent's
      // command list rides along with that same load, so muting it left every
      // restored chat with an empty slash menu ("Загружаем список команд…").
      if (this.suppressUpdates && !KINDS_ALLOWED_THROUGH_LOAD_REPLAY.has(mapped.kind)) return;
      // An open tool keeps the prompt alive even through a silent stretch:
      // tracked after the replay guard so a load replay cannot leave stale
      // in-progress entries behind.
      if (mapped.kind === "tool_call" || mapped.kind === "tool_call_update") {
        if (mapped.toolCallId) {
          if (isActiveToolStatus(mapped.status)) this.activeTools.add(mapped.toolCallId);
          else this.activeTools.delete(mapped.toolCallId);
        }
      }
      // Token/content chunks arrive per-message and drown the log; log only
      // discrete events (tool lifecycle, plan, mode, …).
      if (!NOISY_UPDATE_KINDS.has(mapped.kind)) {
        this.emit("log", `update ${mapped.kind}`);
      }
      this.emit("update", mapped);
      return;
    }

    const requestKind = this.adapter.requestKinds[method];
    if (requestKind && msg.id !== undefined) {
      this.awaitingReply.add(msg.id as JsonRpcId);
      this.emit("request", {
        kind: requestKind,
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    if (method === "elicitation/create" && msg.id !== undefined) {
      this.awaitingReply.add(msg.id as JsonRpcId);
      this.emit("request", {
        kind: "elicitation",
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    const extensionKind = this.adapter.extensionKinds[method];
    if (extensionKind) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      this.emit("extension", { method, kind: extensionKind, params });
      // Request-style extensions expect a harness-specific reply envelope
      // (Cursor `outcome`); notifications get none.
      if (msg.id !== undefined) {
        const reply = this.adapter.extensionReply?.(method, params);
        if (reply !== undefined) this.respond(msg.id as JsonRpcId, reply);
      }
      return;
    }

    // Client-side methods the agent may call (fs / terminal). Always reply.
    if (msg.id !== undefined) {
      this.emit("log", `client method ${method} id=${String(msg.id)}`);
      void this.handleClientMethod(method, (msg.params ?? {}) as Record<string, unknown>)
        .then((result) => this.respond(msg.id as JsonRpcId, result))
        .catch((err) => {
          this.emit("log", `client method ${method} failed: ${String(err)}`);
          this.respondError(msg.id as JsonRpcId, err instanceof Error ? err.message : String(err));
        });
      return;
    }
  }

  /** Normalize a harness `usage_update` payload into our AcpUsage shape. */
  private normalizeUsage(raw: Record<string, unknown>): AcpUsage {
    const u = (raw.usage ?? raw) as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    // ACP stabilized `usage_update`: required `used`/`size`, optional
    // `cost: { amount, currency }`. Tolerate other field spellings too.
    const costObj = (u.cost ?? raw.cost) as Record<string, unknown> | undefined;
    const cost =
      costObj && typeof costObj === "object"
        ? num(costObj.amount)
        : num(u.cost ?? raw.cost);
    const promptDetails = (u.prompt_tokens_details ?? raw.prompt_tokens_details) as
      | Record<string, unknown>
      | undefined;
    return {
      contextWindow: num(
        u.size ?? u.contextWindow ?? u.context_window ?? u.maxTokens ?? u.max_tokens,
      ),
      usedTokens: num(
        u.used ?? u.usedTokens ?? u.totalTokens ?? u.tokenCount ?? u.tokens ?? u.used_tokens,
      ),
      inputTokens: num(u.inputTokens ?? u.promptTokens ?? u.input_tokens),
      outputTokens: num(u.outputTokens ?? u.completionTokens ?? u.output_tokens),
      cachedInputTokens: num(
        u.cachedInputTokens ??
          u.cacheReadTokens ??
          u.cachedTokens ??
          u.cached_input_tokens ??
          promptDetails?.cached_tokens,
      ),
      cost,
      raw,
    };
  }

  private mapUpdate(update: Record<string, unknown>): AcpUpdate {
    const sessionUpdate = String(update.sessionUpdate ?? update.type ?? "other");
    const content = update.content ?? update.text;

    if (
      sessionUpdate === "agent_message_chunk" ||
      sessionUpdate === "agent_message" ||
      sessionUpdate === "message"
    ) {
      // Content block typed as reasoning/thinking must go to the thought channel.
      if (isThoughtContentType(contentBlockType(content))) {
        return { kind: "agent_thought_chunk", text: extractText(content) };
      }
      const raw = extractText(content);
      const split = splitInlineThinking(raw);
      // Harnesses emit this filler for a model message that came out empty; it
      // is protocol filler for the model's history, not content for the user.
      if (isProtocolPlaceholder(split.text || raw)) {
        if (split.thought) return { kind: "agent_thought_chunk", text: split.thought };
        return { kind: "other", sessionUpdate, raw: update };
      }
      if (split.thought && split.text) {
        return { kind: "mixed_chunks", thought: split.thought, text: split.text };
      }
      if (split.thought && !split.text) {
        return { kind: "agent_thought_chunk", text: split.thought };
      }
      return { kind: "agent_message_chunk", text: split.text || raw };
    }
    if (
      sessionUpdate === "agent_thought_chunk" ||
      sessionUpdate === "agent_thought" ||
      sessionUpdate === "reasoning" ||
      sessionUpdate === "reasoning_chunk"
    ) {
      return { kind: "agent_thought_chunk", text: extractText(content) };
    }
    if (sessionUpdate === "user_message_chunk" || sessionUpdate === "user_message") {
      return { kind: "user_message_chunk", text: extractText(update.content) };
    }
    if (sessionUpdate === "tool_call") {
      return {
        kind: "tool_call",
        toolCallId: normalizeToolCallId(update.toolCallId ?? update.toolCallID ?? ""),
        title: typeof update.title === "string" ? update.title : undefined,
        status: typeof update.status === "string" ? update.status : undefined,
        raw: update,
      };
    }
    if (sessionUpdate === "tool_call_update") {
      return {
        kind: "tool_call_update",
        toolCallId: normalizeToolCallId(update.toolCallId ?? update.toolCallID ?? ""),
        status: typeof update.status === "string" ? update.status : undefined,
        raw: update,
      };
    }
    if (sessionUpdate === "tool_call_content_chunk") {
      return {
        kind: "tool_call_content_chunk",
        toolCallId: normalizeToolCallId(update.toolCallId ?? update.toolCallID ?? ""),
        content: update.content,
        raw: update,
      };
    }
    if (sessionUpdate === "plan") return { kind: "plan", raw: update };
    if (sessionUpdate === "session_info_update") return { kind: "session_info", raw: update };
    if (sessionUpdate === "current_mode_update") {
      const modeId = String(update.modeId ?? update.currentModeId ?? update.mode ?? "").trim();
      if (!modeId) return { kind: "other", sessionUpdate, raw: update };
      return { kind: "current_mode", modeId, raw: update };
    }
    if (sessionUpdate === "config_option_update" || sessionUpdate === "config_options_update") {
      const rawOptions = Array.isArray(update.configOptions)
        ? update.configOptions
        : Array.isArray(update.options)
          ? update.options
          : [];
      const configOptions = rawOptions
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const row = item as Record<string, unknown>;
          const id = String(row.id ?? row.configId ?? "").trim();
          if (!id) return null;
          return {
            id,
            name: typeof row.name === "string" ? row.name : undefined,
            category: typeof row.category === "string" ? row.category : undefined,
            type: typeof row.type === "string" ? row.type : undefined,
            currentValue:
              row.currentValue != null
                ? String(row.currentValue)
                : row.value != null
                  ? String(row.value)
                  : undefined,
            options: Array.isArray(row.options)
              ? row.options
                  .map((opt) => {
                    if (!opt || typeof opt !== "object") return null;
                    const o = opt as Record<string, unknown>;
                    const value = String(o.value ?? o.id ?? "").trim();
                    if (!value) return null;
                    return {
                      value,
                      name: String(o.name ?? value),
                    };
                  })
                  .filter(Boolean) as Array<{ value: string; name: string }>
              : undefined,
          } satisfies ConfigOption;
        })
        .filter(Boolean) as ConfigOption[];
      if (!configOptions.length) return { kind: "other", sessionUpdate, raw: update };
      return { kind: "config_options", configOptions, raw: update };
    }
    if (sessionUpdate === "available_commands_update") {
      return { kind: "available_commands", raw: update };
    }
    if (
      sessionUpdate === "usage_update" ||
      sessionUpdate === "usage" ||
      sessionUpdate === "context_update"
    ) {
      return { kind: "usage", usage: this.normalizeUsage(update), raw: update };
    }
    // A harness's own report that it folded older turns into a digest. Not part
    // of ACP: the built-in agent emits it, and any other harness that learns to
    // gets a top-level chat row for free.
    if (sessionUpdate === "compaction" || sessionUpdate === "compaction_update") {
      return { kind: "compaction", raw: update };
    }
    return { kind: "other", sessionUpdate, raw: update };
  }
}
