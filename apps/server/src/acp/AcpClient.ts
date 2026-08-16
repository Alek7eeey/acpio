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
  providerArgs,
  providerCommand,
  resolveModelParamValue,
  modelParamFamily,
  type AgentMode,
  type AgentProvider,
  type AppSettings,
} from "@acprocess/shared";

const execFileAsync = promisify(execFile);

type JsonRpcId = number | string;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
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
  | { kind: "plan"; raw: Record<string, unknown> }
  | { kind: "session_info"; raw: Record<string, unknown> }
  | { kind: "current_mode"; modeId: string; raw: Record<string, unknown> }
  | { kind: "config_options"; configOptions: ConfigOption[]; raw: Record<string, unknown> }
  | { kind: "available_commands"; raw: Record<string, unknown> }
  | { kind: "mixed_chunks"; thought?: string; text?: string }
  | { kind: "other"; sessionUpdate: string; raw: Record<string, unknown> };

export type AcpRequest =
  | { kind: "permission"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "ask_question"; id: JsonRpcId; params: Record<string, unknown> }
  | { kind: "create_plan"; id: JsonRpcId; params: Record<string, unknown> };

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
 * Cursor gets Agent/Plan/Ask when the agent omits the list.
 */
export function listAgentModes(
  options: ConfigOption[],
  provider?: AgentProvider,
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
  // Cursor ACP supports these even when configOptions omit the mode select.
  if (provider === "cursor") {
    return [
      { value: "agent", name: "Agent" },
      { value: "plan", name: "Plan" },
      { value: "ask", name: "Ask" },
    ];
  }
  // OMP (and similar) only advertise a single "default" mode — not a real switcher.
  return [];
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

function winKnownBins(command: string): string[] {
  const home = process.env.USERPROFILE ?? "";
  const local = process.env.LOCALAPPDATA ?? "";
  const appData = process.env.APPDATA ?? "";
  const names =
    command === "agent" || command === "cursor-agent"
      ? ["agent.exe", "agent.cmd", "cursor-agent.exe", "cursor-agent.cmd"]
      : command === "omp" || command === "omp-acp"
        ? ["omp.exe", "omp.cmd", "omp-acp.exe", "omp-acp.cmd"]
        : [`${command}.exe`, `${command}.cmd`];

  const dirs = [
    local ? path.join(local, "cursor-agent") : "",
    local ? path.join(local, "omp") : "",
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

export async function resolveCommand(command: string): Promise<{ cmd: string; shell: boolean }> {
  if (/\.(exe|cmd|bat)$/i.test(command) || command.includes("/") || command.includes("\\")) {
    return { cmd: command, shell: /\.(cmd|bat)$/i.test(command) };
  }

  if (process.platform === "win32") {
    const known = winKnownBins(command);
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

function commandNotFoundHint(provider: AgentProvider, command: string): string {
  if (provider === "cursor") {
    return (
      `Команда "${command}" не найдена. Cursor IDE ≠ Cursor CLI. ` +
      `Установите CLI (PowerShell): irm 'https://cursor.com/install?win32=true' | iex ` +
      `затем выполните agent login. Или укажите полный путь в «CLI и права».`
    );
  }
  if (provider === "omp") {
    return (
      `Команда "${command}" не найдена. Убедитесь, что omp в PATH ` +
      `(или поставьте omp-acp и укажите его в «CLI и права»).`
    );
  }
  return (
    `Команда "${command}" не найдена. Cursor IDE ≠ Cursor CLI. ` +
    `Установите CLI (PowerShell): irm 'https://cursor.com/install?win32=true' | iex ` +
    `затем выполните agent login. Или укажите полный путь в «CLI и права».`
  );
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

export function buildAgentEnv(provider: AgentProvider, settings: AppSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (settings.cursorApiKey) env.CURSOR_API_KEY = settings.cursorApiKey;
  if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;
  if (settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
  if (process.platform === "win32") {
    const extras: string[] = [];
    if (process.env.LOCALAPPDATA) {
      extras.push(path.join(process.env.LOCALAPPDATA, "cursor-agent"));
      extras.push(path.join(process.env.LOCALAPPDATA, "omp"));
    }
    if (process.env.USERPROFILE) {
      extras.push(path.join(process.env.USERPROFILE, ".local", "bin"));
    }
    if (process.env.APPDATA) {
      extras.push(path.join(process.env.APPDATA, "npm"));
    }
    env.PATH = `${extras.join(";")};${env.PATH ?? ""}`;
  }
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
    sessionCapabilities?: { resume?: Record<string, unknown> };
  } = {};
  /** While true (Cursor session/load replay), drop session/update notifications. */
  private suppressUpdates = false;

  /** OMP-style silent restore: agent supports `session/resume`. */
  get canResumeSession(): boolean {
    return Boolean(this.capabilities.sessionCapabilities?.resume);
  }

  /** Cursor-style restore: agent supports `session/load` (replays history). */
  get canLoadSession(): boolean {
    return this.capabilities.loadSession === true;
  }

  constructor(
    private readonly provider: AgentProvider,
    private readonly settings: AppSettings,
    private readonly cwd: string,
    private mode: AgentMode,
  ) {
    super();
  }

  /** Exact file paths (outside the cwd) the agent may READ — user-attached files. */
  private extraReadFiles = new Set<string>();

  allowReadFile(absPath: string) {
    this.extraReadFiles.add(path.resolve(absPath));
  }

  get lastStderr() {
    return this.stderrBuf.slice(-4000);
  }

  async start(
    timeoutMs = 45000,
    opts?: {
      catalogOnly?: boolean;
      /** Reattach an existing agent session instead of creating a new one. */
      resume?: { sessionId: string; mode: "resume" | "load" };
    },
  ): Promise<void> {
    const commandName = providerCommand(this.settings, this.provider);
    const args = [...providerArgs(this.settings, this.provider)];
    const resolved = await resolveCommand(commandName);
    const env = buildAgentEnv(this.provider, this.settings);
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
        throw new Error(commandNotFoundHint(this.provider, commandName));
      }
    }

    this.emit("log", `starting ${resolved.cmd} ${args.join(" ")} cwd=${cwd}`);

    this.proc = spawn(resolved.cmd, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: resolved.shell,
      windowsHide: true,
    });

    this.proc.on("error", (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? commandNotFoundHint(this.provider, commandName)
          : `spawn error: ${err.message}`;
      this.emit("log", msg);
      const wrapped = new Error(msg);
      for (const [, p] of this.pending) p.reject(wrapped);
      this.pending.clear();
    });

    this.proc.stderr.on("data", (buf: Buffer) => {
      const text = decodeProcessText(buf);
      this.stderrBuf += text;
      this.emit("log", text);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const tail = this.stderrBuf.slice(-500);
      const message = looksLikeCommandNotFound(tail)
          ? commandNotFoundHint(this.provider, commandName)
          : `ACP process exited (${code ?? signal})${tail ? `: ${tail}` : ""}`;
      const err = new Error(message);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.killAllTerminals();
      this.emit("exit", { code, signal });
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));

    const boot = async () => {
      const initResult = (await this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          // Cursor: expose model + fast/effort as separate config options
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: { name: "acprocess", version: "0.1.0" },
      })) as {
        agentCapabilities?: {
          loadSession?: boolean;
          sessionCapabilities?: { resume?: Record<string, unknown> };
        };
      };
      this.capabilities = initResult?.agentCapabilities ?? {};

      if (this.provider === "cursor") {
        try {
          await this.send("authenticate", { methodId: "cursor_login" });
        } catch (err) {
          this.emit("log", `authenticate skipped/failed: ${String(err)}`);
        }
      }

      const mcpServers = (this.settings.mcpServers ?? [])
        .filter((s) => s.enabled && s.url?.trim())
        .map((s) => ({
          name: s.name,
          type: "http",
          url: s.url!.trim(),
          headers:
            s.type === "remote" && s.token?.trim()
              ? [{ name: "Authorization", value: `Bearer ${s.token.trim()}` }]
              : [],
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
        // Cursor replays the whole stored conversation here; we already have
        // it in our DB, so swallow the notifications instead of double-writing.
        this.suppressUpdates = true;
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
          await this.applyModelSelection(this.settings.defaultModel, this.settings.defaultModelParams);
        }
      } catch (err) {
        this.emit("log", `set model failed: ${String(err)}`);
      }

      const modes = listAgentModes(this.configOptions, this.provider, this.sessionModes);
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
    const modes = listAgentModes(this.configOptions, this.provider, this.sessionModes);
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
    // Never send `composer-2.5[fast=true]` as a model id — always base (+ params separately).
    const base = parsed.base || wire;
    const target =
      !allowedModels.length ||
      allowedModels.includes(base) ||
      allowedModels.includes(wire)
        ? base
        : null;
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
    if (!this.sessionId || !this.proc) return;
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

  respond(id: JsonRpcId, result: unknown) {
    this.emit("log", `respond id=${String(id)}`);
    this.write({ jsonrpc: "2.0", id, result });
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

  private killAllTerminals() {
    for (const [, t] of this.terminals) {
      try {
        t.proc.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }

  private appendTerminalOutput(entry: TerminalEntry, chunk: string) {
    entry.output += chunk;
    if (entry.output.length > entry.byteLimit) {
      entry.truncated = true;
      entry.output = entry.output.slice(entry.output.length - entry.byteLimit);
    }
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
    // Avoid shell:true on Windows — it can hang or mangle argv for curl/web fetches.
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
    this.emit("log", `terminal/create ${id} ${command} ${args.join(" ")}`.trim());

    child.stdout.on("data", (buf: Buffer) => this.appendTerminalOutput(entry, buf.toString("utf8")));
    child.stderr.on("data", (buf: Buffer) => this.appendTerminalOutput(entry, buf.toString("utf8")));
    child.on("error", (err) => this.appendTerminalOutput(entry, `\n[spawn error] ${err.message}\n`));
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
      try {
        entry.proc.kill();
      } catch {
        // ignore
      }
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
        try {
          entry.proc.kill();
        } catch {
          // ignore
        }
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
    if (entry) {
      try {
        entry.proc.kill();
      } catch {
        // ignore
      }
    }
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
   * Ceiling for any single ACP request (prompt, tool call, config change, …).
   * A wedged agent — e.g. an MCP tool server that never answers — would
   * otherwise keep the session "running" forever and lock the whole chat.
   */
  private static readonly REQUEST_TIMEOUT_MS = 5 * 60_000;

  private request(
    method: string,
    params: unknown,
  ): { id: JsonRpcId; promise: Promise<unknown> } {
    if (!this.proc || this.closed) {
      return {
        id: -1,
        promise: Promise.reject(new Error("ACP client is closed")),
      };
    }
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.promptRequestId === id) this.promptRequestId = null;
        const msg = `Таймаут ответа ACP (${AcpClient.REQUEST_TIMEOUT_MS / 1000}с) на "${method}". ` +
          `Агент не отвечает — возможно, завис внешний MCP-сервер или CLI.`;
        this.emit("log", msg);
        reject(new Error(msg));
      }, AcpClient.REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    return { id, promise };
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(msg: unknown) {
    if (!this.proc?.stdin.writable) return;
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

    if (method === "session/request_permission" && msg.id !== undefined) {
      this.emit("request", {
        kind: "permission",
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    if (method === "cursor/ask_question" && msg.id !== undefined) {
      this.emit("request", {
        kind: "ask_question",
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    if (method === "cursor/create_plan" && msg.id !== undefined) {
      this.emit("request", {
        kind: "create_plan",
        id: msg.id as JsonRpcId,
        params: (msg.params ?? {}) as Record<string, unknown>,
      } satisfies AcpRequest);
      return;
    }

    if (
      method === "cursor/update_todos" ||
      method === "cursor/task" ||
      method === "cursor/generate_image"
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      this.emit("extension", { method, params });
      if (msg.id !== undefined) {
        // Cursor extension methods expect an `outcome` envelope. An empty `{}`
        // makes the parent agent treat the Task as "no result" and retry.
        if (method === "cursor/task") {
          this.respond(msg.id as JsonRpcId, {
            outcome: {
              outcome: "completed",
              ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
              ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
            },
          });
        } else if (method === "cursor/update_todos") {
          const todos = Array.isArray(params.todos) ? params.todos : [];
          this.respond(msg.id as JsonRpcId, {
            outcome: { outcome: "accepted", todos },
          });
        } else {
          const filePath = typeof params.filePath === "string" ? params.filePath : "";
          this.respond(
            msg.id as JsonRpcId,
            filePath
              ? { outcome: { outcome: "generated", filePath } }
              : { outcome: { outcome: "rejected", reason: "missing filePath" } },
          );
        }
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
        toolCallId: String(update.toolCallId ?? update.toolCallID ?? ""),
        title: typeof update.title === "string" ? update.title : undefined,
        status: typeof update.status === "string" ? update.status : undefined,
        raw: update,
      };
    }
    if (sessionUpdate === "tool_call_update") {
      return {
        kind: "tool_call_update",
        toolCallId: String(update.toolCallId ?? update.toolCallID ?? ""),
        status: typeof update.status === "string" ? update.status : undefined,
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
    return { kind: "other", sessionUpdate, raw: update };
  }
}
