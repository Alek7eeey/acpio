import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  parseModelWire,
  resolveModelParamValue,
  modelParamFamily,
  normalizeToolCallId,
  type AgentMode,
  type AgentProvider,
  type AcpUsage,
  type AppSettings,
  type HarnessAdapter,
  type McpServerConfig,
  mcpHttpHeaders,
  mcpRemoteExtras,
} from "@acpio/shared";
import {
  appendDeepLog,
  rpcMethod,
  type DeepLogContext,
} from "../services/deepLogging.js";
import { adapterArgs, adapterCommand, adapterSetting } from "../adapters/registry.js";

const execFileAsync = promisify(execFile);

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
  | { kind: "other"; sessionUpdate: string; raw: Record<string, unknown> };

export type AcpRequest =
  | { kind: "permission"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "ask_question"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "create_plan"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "elicitation"; id: JsonRpcId; params: Record<string, unknown> };

export type ConfigOption = {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string }>;
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

function winKnownBins(command: string, adapter: HarnessAdapter): string[] {
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

  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) out.push(full);
    }
  }
  return out;
}

export async function resolveCommand(
  command: string,
  adapter?: HarnessAdapter,
): Promise<{ cmd: string; shell: boolean }> {
  if (/\.(exe|cmd|bat)$/i.test(command) || command.includes("/") || command.includes("\\")) {
    return { cmd: command, shell: /\.(cmd|bat)$/i.test(command) };
  }

  if (process.platform === "win32") {
    const known = adapter ? winKnownBins(command, adapter) : [];
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

export class AcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
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
  /** While true (Cursor session/load replay), drop session/update notifications. */
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
    this.proc = child;

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
    });

    child.stderr.on("data", (buf: Buffer) => {
      const text = decodeProcessText(buf);
      this.stderrBuf += text;
      // Debug/diagnostic traffic only — user-visible output comes from ACP terminals.
      this.emit("log", text);
    });

    child.on("exit", (code, signal) => {
      this.closed = true;
      const tail = this.stderrBuf.slice(-500);
      const message = looksLikeCommandNotFound(tail)
        ? installHintFor(this.adapter, commandName)
        : `ACP process exited (${code ?? signal})${tail ? `: ${tail}` : ""}`;
      const err = new Error(message);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.killAllTerminals();
      this.emit("exit", { code, signal });
    });

    const rl = readline.createInterface({ input: child.stdout });
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
    const commandName = adapterCommand(this.adapter, this.settings);
    const args = adapterArgs(this.adapter, this.settings);
    const resolved = await resolveCommand(commandName, this.adapter);
    const env = buildAgentEnv(this.adapter, this.settings);
    const cwd = this.cwd || process.cwd();
    // A missing cwd makes the child die with a generic "cannot find the path"
    // error that reads like a missing command — fail fast with a clear message.
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Рабочая папка не существует: ${cwd}. Выберите другую папку в настройках.`);
    }

    const resolvedExists =
      resolved.cmd.includes("/") ||
      resolved.cmd.includes("\\") ||
      /\.(exe|cmd|bat)$/i.test(resolved.cmd)
        ? fs.existsSync(resolved.cmd)
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

      const mcpServers = (opts?.mcpServers ?? this.settings.mcpServers ?? [])
        .filter((s) => s.enabled && s.url?.trim())
        .map((s) => ({
          name: s.name,
          type: "http",
          url: s.url!.trim(),
          headers: mcpHttpHeaders(s),
          // Self-signed / internal-CA endpoints: let the harness skip cert
          // verification for this server only.
          ...(s.insecureTls ? { insecureTls: true } : {}),
          ...mcpRemoteExtras(s),
        }));

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
    let target: string | null;
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
        target = base;
      }
    }
    if (!target) {
      this.emit(
        "log",
        `model skip: "${base}" is not in this agent's model list (${this.provider})`,
      );
      return;
    }

    await this.setConfigOption(modelId, target);
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

  async prompt(text: string): Promise<{ stopReason?: string; raw: unknown }> {
    if (!this.sessionId) throw new Error("ACP session not started");
    // A second session/prompt while one is open cancels/queues the in-flight turn in OMP
    // (e.g. /review after elicitation). Never stack prompts on one client.
    if (this.promptRequestId != null) {
      throw new Error("ACP prompt already in flight");
    }
    const { id, promise } = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
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
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !this.isConnected()) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
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
    this.emit("log", `respond id=${String(id)}`);
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Send an arbitrary ACP request to the agent (`_omp/*` extension methods). */
  requestAgent<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.send(method, params) as Promise<T>;
  }

  respondError(id: JsonRpcId, message: string, code = -32000) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  dispose() {
    this.closed = true;
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

  private assertInsideCwd(targetPath: string) {
    const root = this.rootCwd();
    const resolved = path.resolve(root, targetPath);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path outside session cwd: ${resolved}`);
    }
    return resolved;
  }

  /** Reads may also target user-attached files outside the cwd (exact paths). */
  private assertReadablePath(targetPath: string) {
    const resolved = path.resolve(this.rootCwd(), targetPath);
    const rel = path.relative(this.rootCwd(), resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolved;
    const norm = (p: string) =>
      process.platform === "win32" ? p.toLowerCase() : p;
    if ([...this.extraReadFiles].some((f) => norm(f) === norm(resolved))) {
      return resolved;
    }
    throw new Error(`Path outside session cwd: ${resolved}`);
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
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, Number(params.line ?? 1) - 1);
    const limit = params.limit == null ? undefined : Number(params.limit);
    const sliced = limit == null ? lines.slice(start) : lines.slice(start, start + limit);
    return { content: sliced.join("\n") };
  }

  private async handleFsWrite(params: Record<string, unknown>) {
    const filePath = this.assertInsideCwd(String(params.path ?? ""));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, String(params.content ?? ""), "utf8");
    return {};
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

  private async handleClientMethod(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "fs/read_text_file":
        return this.handleFsRead(params);
      case "fs/write_text_file":
        return this.handleFsWrite(params);
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
          if (!this.closed && this.isConnected() && idleMs < AcpClient.requestTimeoutMs) {
            this.emit(
              "log",
              `ACP "${method}" still active (last traffic ${Math.round(idleMs / 1000)}s ago) — extending wait`,
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
    if (wirePath) {
      try {
        fs.appendFileSync(
          wirePath,
          `${JSON.stringify({ ts: new Date().toISOString(), dir: "out", msg })}\n`,
        );
      } catch {
        /* ignore */
      }
    }
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
    if (wirePath) {
      try {
        fs.appendFileSync(
          wirePath,
          `${JSON.stringify({ ts: new Date().toISOString(), dir: "in", msg })}\n`,
        );
      } catch {
        /* ignore */
      }
    }

    if ("id" in msg && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const id = msg.id as JsonRpcId;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (msg.error) {
        const err = msg.error as { message?: string; data?: unknown };
        waiter.reject(
          new Error(err.message ?? "ACP error" + (err.data ? ` ${JSON.stringify(err.data)}` : "")),
        );
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    const method = msg.method as string | undefined;
    if (!method) return;

    if (method === "session/update") {
      if (this.suppressUpdates) return; // Cursor session/load replay — history is already in our DB
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const update = (params.update ?? params) as Record<string, unknown>;
      const mapped = this.mapUpdate(update);
      this.emit("log", `update ${mapped.kind}`);
      this.emit("update", mapped);
      return;
    }

    const requestKind = this.adapter.requestKinds[method];
    if (requestKind && msg.id !== undefined) {
      this.emit("request", {
        kind: requestKind,
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    if (method === "elicitation/create" && msg.id !== undefined) {
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
    return {
      contextWindow: num(
        u.size ?? u.contextWindow ?? u.context_window ?? u.maxTokens ?? u.max_tokens,
      ),
      usedTokens: num(
        u.used ?? u.usedTokens ?? u.totalTokens ?? u.tokenCount ?? u.tokens ?? u.used_tokens,
      ),
      inputTokens: num(u.inputTokens ?? u.promptTokens ?? u.input_tokens),
      outputTokens: num(u.outputTokens ?? u.completionTokens ?? u.output_tokens),
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
    return { kind: "other", sessionUpdate, raw: update };
  }
}
