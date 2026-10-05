import type {
  AgentMode,
  AgentModeOption,
  AgentProvider,
  CustomAgentSpec,
  ModelOption,
} from "./adapters.js";

export type {
  AdapterExtensionKind,
  AdapterMetaDto,
  AdapterProbeContext,
  AdapterRegistry,
  AdapterRestoreMode,
  AdapterTranscriptClient,
  AgentModeOption,
  AgentProvider,
  AgentMode,
  CustomAgentSpec,
  HarnessAdapter,
  InProcessAgentOptions,
  InProcessAgentTransport,
  ModelOption,
  SubagentCardUpdate,
  SubagentProgressUpdate,
  SubagentToolEvent,
  SubagentTranscriptPage,
} from "./adapters.js";
export {
  CUSTOM_AGENT_ID_RE,
  CUSTOM_AGENT_MAX,
  customAgentAdapter,
  isShellSession,
  normalizeCustomAgentId,
  normalizeCustomAgents,
  SHELL_SESSION_PROVIDER,
} from "./adapters.js";
export { CONSOLE_TERMINAL_LIMITS, clampConsoleTerminalSize } from "./consoleTerminal.js";
export { isProtocolPlaceholder } from "./protocolPlaceholder.js";
export { DEFAULT_DEV_UI_PORT, DEFAULT_SERVER_PORT, resolveServerPort } from "./ports.js";

export { BUILD_INFO } from "./buildInfo.js";
export { normalizeToolCallId, toolCallIdVariants } from "./toolCallId.js";
export {
  CHAT_TREE_RECENT_LIMIT_MAX,
  SETTINGS_SCHEMA_VERSION,
  mergeChatChipOptions,
  mergeClientAppSettings,
  normalizeChatChipOptions,
  normalizeChatMetaChips,
  normalizeChatTreeRecentLimit,
  readSettingsSchema,
} from "./appSettingsMerge.js";
export {
  isToolPermissionOption,
  permissionOptionsLookLikeQuestion,
  questionPayloadFromPermission,
  type InteractiveOption,
} from "./interactive.js";
export {
  elicitationContentFromUiAnswers,
  elicitationResponseFromUiOutcome,
  elicitationSchemaToQuestionPayload,
  type ElicitationFormQuestion,
  type ElicitationQuestionPayload,
  type ElicitationRequestedSchema,
  type ElicitationUiAnswer,
} from "./elicitationForm.js";
export { summarizeQuestionAnswer, type QuestionAnswerPayload } from "./questionAnswer.js";
export {
  SESSION_TITLE_MAX_LEN,
  sanitizeTitleSource,
  titleFromUserText,
  truncateSessionTitle,
} from "./sessionTitle.js";

/** Extract the first readable text from an unknown tool/subagent payload. */
export function textFromUnknown(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        return textFromUnknown(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromUnknown(item))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.prompt === "string") return obj.prompt;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.thinking === "string") return obj.thinking;
    if (typeof obj.reasoning === "string") return obj.reasoning;
    if (typeof obj.delta === "string") return obj.delta;
    if (obj.content !== undefined) return textFromUnknown(obj.content);
    if (obj.result !== undefined) return textFromUnknown(obj.result);
  }
  return "";
}

/**
 * Split a tool-call `content` payload into live reasoning vs visible result text.
 * Cursor streams subagent progress as content blocks (`thinking` / `text`) on
 * `tool_call_update` while status is still in_progress — those must reach the card
 * before the terminal update.
 */
export function extractSubagentLiveContent(raw: Record<string, unknown>): {
  thinking: string[];
  result: string;
} {
  const thinking: string[] = [];
  const texts: string[] = [];

  const pushThought = (value: unknown) => {
    const text = textFromUnknown(value).trim();
    if (text && !thinking.includes(text)) thinking.push(text);
  };
  const pushText = (value: unknown) => {
    const text = textFromUnknown(value).trim();
    if (text) texts.push(text);
  };

  const walk = (node: unknown, depth = 0) => {
    if (node == null || depth > 10) return;
    if (typeof node === "string") {
      pushText(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    if (/^(thinking|reasoning|thought|agent_thought)$/.test(type)) {
      pushThought(obj.thinking ?? obj.reasoning ?? obj.text ?? obj.delta ?? obj.content);
      return;
    }
    if (/^(diff|terminal|image|resource|blob)$/.test(type)) return;
    if (type === "content" || type === "text" || type === "output_text" || type === "input_text") {
      pushText(obj.content ?? obj.text ?? obj.delta);
      return;
    }
    if (typeof obj.thinking === "string" || typeof obj.reasoning === "string") {
      pushThought(obj.thinking ?? obj.reasoning);
    }
    if (typeof obj.delta === "string") {
      pushText(obj.delta);
      return;
    }
    if (typeof obj.text === "string") {
      pushText(obj.text);
      return;
    }
    if (obj.content !== undefined) walk(obj.content, depth + 1);
  };

  if (raw.content !== undefined) walk(raw.content);
  const top =
    textFromUnknown(raw.result).trim() ||
    textFromUnknown(raw.output).trim() ||
    (typeof raw.text === "string" ? raw.text.trim() : "");
  if (top && !texts.includes(top)) texts.push(top);

  return { thinking, result: texts.join("\n\n") };
}
/**
 * Rough estimate of how many LLM context tokens a conversation occupies.
 * Sums the characters of every message part's meaningful content and divides
 * by ~4 (a common heuristic for mixed EN/RU/code text). The number is an
 * estimate, not an exact harness-reported token count.
 */
export interface ContextUsage {
  /** Total characters of conversation content. */
  chars: number;
  /** Estimated token count (ceil(chars / CHARS_PER_TOKEN)). */
  tokens: number;
}

const CHARS_PER_TOKEN = 4;

/** Meaningful text a part contributes to the model context. */
function partContextText(part: MessagePartDto): string {
  const payload = (part.payload ?? {}) as Record<string, unknown>;
  switch (part.type) {
    case "text":
    case "thought":
    case "status":
      return String(payload.text ?? payload.message ?? payload.summary ?? "");
    case "tool_call": {
      const raw = (payload.raw ?? {}) as Record<string, unknown>;
      const input = raw.rawInput ?? raw.input ?? raw.arguments ?? payload.input;
      const args =
        input != null
          ? typeof input === "string"
            ? input
            : JSON.stringify(input)
          : "";
      const title = String(payload.title ?? payload.description ?? "").trim();
      return [title, args].filter(Boolean).join(" ");
    }
    case "plan":
      return [payload.name, payload.plan].map((v) => String(v ?? "")).join(" ").trim();
    case "todo": {
      const items = Array.isArray(payload.items) ? payload.items : [];
      return items
        .map((it) => String((it ?? ({} as Record<string, unknown>)).text ?? (it ?? ({} as Record<string, unknown>)).name ?? ""))
        .filter(Boolean)
        .join("\n");
    }
    case "question":
    case "permission":
      return String(
        payload.text ?? payload.message ?? payload.question ?? payload.prompt ?? "",
      );
    case "subagent": {
      const raw = (payload.raw ?? {}) as Record<string, unknown>;
      const body =
        textFromUnknown(payload.result) ||
        textFromUnknown(raw.result) ||
        textFromUnknown(payload.prompt) ||
        textFromUnknown(raw.prompt);
      const title = String(payload.title ?? payload.description ?? raw.title ?? "").trim();
      return [title, body].filter(Boolean).join(" ");
    }
    case "error":
      return String(payload.message ?? payload.text ?? "");
    case "file":
      return [payload.name, payload.path].map((v) => String(v ?? "")).join(" ").trim();
    default:
      return "";
  }
}

export function estimateContextUsage(messages: MessageDto[]): ContextUsage {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      chars += partContextText(part).length;
    }
  }
  return { chars, tokens: Math.max(0, Math.ceil(chars / CHARS_PER_TOKEN)) };
}

/**
 * Normalized fields of a subagent request/roster entry: prompt, result and a
 * meaningful title (explicit field or `### Heading` / `Label:` / task-result
 * id from the body).
 */
export function subagentFieldsFromRaw(raw: Record<string, unknown>): {
  prompt?: string;
  result?: string;
  title?: string;
  description?: string;
} {
  const args = (raw.rawInput ?? raw.input ?? raw.arguments) as Record<string, unknown> | undefined;
  const prompt =
    textFromUnknown(raw.prompt) ||
    textFromUnknown(args?.prompt) ||
    textFromUnknown((raw.arguments as Record<string, unknown> | undefined)?.prompt) ||
    textFromUnknown((raw.input as Record<string, unknown> | undefined)?.prompt);
  const result = textFromUnknown(raw.result) || textFromUnknown(raw.content);
  const fromArgs = String(args?.description ?? args?.title ?? args?.name ?? "").trim();
  const titled = String(raw.title ?? raw.description ?? raw.name ?? raw.label ?? "").trim();
  const fromBody =
    result.match(/^###\s+([^\n\[]+?)(?:\s*\[|$)/m)?.[1]?.trim() ||
    result.match(/^\s*Label:\s*(.+)$/m)?.[1]?.trim() ||
    result.match(/<task-result\b[^>]*\bid="([^"]+)"/i)?.[1]?.trim() ||
    "";
  // Prefer Task `description` over ACP placeholders like "Task: Subagent task" / "other".
  const niceTitle = [fromArgs, titled, fromBody].find(
    (v) => v && !isPlaceholderSubagentTitle(v),
  );
  return {
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(niceTitle ? { title: niceTitle, description: niceTitle } : {}),
  };
}

/** ACP/Cursor placeholders that must never be shown as a subagent card title. */
export function isPlaceholderSubagentTitle(title: string): boolean {
  const value = title.trim();
  if (!value) return true;
  return /^(tool|task|subagent|other|агент|субагент|task\s*:\s*subagent(\s+task)?)$/i.test(value);
}

/** MCP server connection defined in Settings → MCP. */
export type McpServerConfig = {
  /** Stable unique id. */
  id: string;
  name: string;
  enabled: boolean;
  /**
   * "local" — same-network HTTP endpoint (URL only);
   * "remote" — external HTTP endpoint with token/JSON;
   * "stdio" — agent-spawned process (command + args).
   */
  type: "local" | "remote" | "stdio";
  /** Endpoint URL (HTTP types). */
  url?: string;
  /** Bearer token for remote servers (legacy — prefer remoteConfig JSON). */
  token?: string;
  /** Skip TLS certificate verification (self-signed / internal CA endpoints). */
  insecureTls?: boolean;
  /** @deprecated Legacy HTTP headers — prefer remoteConfig JSON. */
  headers?: Array<{ name: string; value: string }>;
  /** Remote MCP: free-form JSON (headers, token, transport options). */
  remoteConfig?: string;
  /** Stdio MCP: executable the agent should spawn. */
  command?: string;
  /** Stdio MCP: argv after the command. */
  args?: string[];
  /** Stdio MCP: env vars passed through to ACP (`{ name, value }[]`). */
  env?: Array<{ name: string; value: string }>;
  /** Stdio MCP: env as a JSON object `{"KEY":"value"}` (UI draft; merged into `env`). */
  envConfig?: string;
};

/**
 * Per-folder MCP overrides, keyed by the folder's canonical cwd (see
 * `canonicalCwd`). A folder can switch individual servers on or off — a
 * server that is off globally included, so the global list stays the single
 * place a server is defined — and add servers that only exist for chats
 * opened in it.
 */
export type McpFolderConfig = {
  /**
   * Explicit per-server switch for this folder, keyed by server id (`true`
   * attaches it here even when it is off globally, `false` switches it off
   * here). An id that is absent inherits the server's own `enabled` flag, so
   * a later global change still reaches every folder that has no opinion.
   */
  overrides: Record<string, boolean>;
  /** Servers that exist only in this folder (merged after the global list). */
  servers: McpServerConfig[];
};

function legacyMcpHttpHeaders(server: McpServerConfig): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (server.type === "remote" && server.token?.trim()) {
    out.push({ name: "Authorization", value: `Bearer ${server.token.trim()}` });
  }
  for (const row of server.headers ?? []) {
    const name = row.name?.trim();
    if (!name) continue;
    const value = row.value ?? "";
    const idx = out.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) out[idx] = { name, value };
    else out.push({ name, value });
  }
  return out;
}

/** Parsed remote MCP JSON merged with legacy token/headers fields. */
export function parseMcpRemoteConfig(server: McpServerConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw = server.remoteConfig?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        Object.assign(out, parsed as Record<string, unknown>);
      }
    } catch {
      /* invalid JSON — legacy fields still apply */
    }
  }
  const legacy = legacyMcpHttpHeaders(server);
  if (legacy.length) {
    const headers =
      out.headers && typeof out.headers === "object" && !Array.isArray(out.headers)
        ? { ...(out.headers as Record<string, string>) }
        : {};
    for (const row of legacy) headers[row.name] = row.value;
    out.headers = headers;
  }
  return out;
}

export function mcpHttpHeaders(server: McpServerConfig): Array<{ name: string; value: string }> {
  const config = parseMcpRemoteConfig(server);
  const headers = config.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    return Object.entries(headers as Record<string, unknown>)
      .map(([name, value]) => ({ name, value: String(value ?? "") }))
      .filter((row) => row.name.trim());
  }
  return legacyMcpHttpHeaders(server);
}

/** Extra MCP fields (except url/name/type) passed through to the ACP agent. */
export function mcpRemoteExtras(server: McpServerConfig): Record<string, unknown> {
  const config = parseMcpRemoteConfig(server);
  const { headers: _headers, ...rest } = config;
  return rest;
}

/** Env vars for a stdio MCP server (`env` array wins over `envConfig` JSON). */
export function mcpStdioEnv(server: McpServerConfig): Array<{ name: string; value: string }> {
  if (server.env?.length) {
    return server.env
      .map((row) => ({ name: row.name?.trim() ?? "", value: String(row.value ?? "") }))
      .filter((row) => row.name);
  }
  const raw = server.envConfig?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const name = String((row as { name?: unknown }).name ?? "").trim();
          if (!name) return null;
          return { name, value: String((row as { value?: unknown }).value ?? "") };
        })
        .filter((row): row is { name: string; value: string } => Boolean(row));
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([name, value]) => ({ name: name.trim(), value: String(value ?? "") }))
        .filter((row) => row.name);
    }
  } catch {
    /* invalid JSON — no extra env */
  }
  return [];
}

/**
 * True when a stdio MCP command cannot be resolved by the agent's own PATH
 * lookup. The ACP spec requires an absolute path, and OMP in particular spawns
 * client-supplied servers with `Bun.spawn` (no shell), so a bare `npx` /
 * `mcp-gitea` never launches. Slash/backslash paths are already resolvable.
 */
export function mcpCommandNeedsAbsolute(server: McpServerConfig): boolean {
  if (server.type !== "stdio") return false;
  const command = server.command?.trim() ?? "";
  if (!command) return false;
  return !/[\\/]/.test(command);
}

/** True when the server has the fields its transport needs (ignores `enabled`). */
export function isMcpServerConfigured(server: McpServerConfig): boolean {
  if (server.type === "stdio") return Boolean(server.command?.trim());
  return Boolean(server.url?.trim());
}

/** Globally enabled MCP server that can be attached to an agent session. */
export function isMcpServerAttached(server: McpServerConfig): boolean {
  return Boolean(server.enabled) && isMcpServerConfigured(server);
}

/** Human-readable endpoint for lists/tooltips: URL or `command args…`. */
export function mcpServerEndpoint(server: McpServerConfig): string {
  if (server.type === "stdio") {
    return [server.command?.trim(), ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  return server.url?.trim() ?? "";
}

/** ACP `session/new|resume|load` mcpServers entry (stdio has no `type` field). */
export function toAcpMcpServer(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "stdio") {
    return {
      name: server.name,
      command: server.command!.trim(),
      args: server.args ?? [],
      env: mcpStdioEnv(server),
    };
  }
  return {
    name: server.name,
    type: "http",
    url: server.url!.trim(),
    headers: mcpHttpHeaders(server),
    ...(server.insecureTls ? { insecureTls: true } : {}),
    ...mcpRemoteExtras(server),
  };
}

/** Stable fingerprint of the attached MCP list (restarts when this changes). */
export function mcpServersFingerprint(servers: McpServerConfig[] | undefined): string {
  return (servers ?? [])
    .filter(isMcpServerAttached)
    .map((s) => {
      if (s.type === "stdio") {
        return `${s.name}|stdio|${s.command!.trim()}|${(s.args ?? []).join("\t")}|${JSON.stringify(mcpStdioEnv(s))}`;
      }
      return `${s.name}|${s.type}|${s.url!.trim()}|${s.insecureTls ? "1" : "0"}|${JSON.stringify(parseMcpRemoteConfig(s))}`;
    })
    .sort()
    .join("\u0000");
}

/**
 * Canonical working-directory form: forward slashes, no trailing separator —
 * except a filesystem root, where the separator is the whole path. `E:\proj`
 * and `E:/proj/` are one folder, while `C:\` and `C:/` must stay roots: a
 * stripped drive root becomes the drive-relative `C:`, which harnesses reject
 * outright (OMP answers `session/new` with `-32603 Internal error`).
 */
export function canonicalCwd(cwd: string | null | undefined): string {
  const slashed = (cwd ?? "").trim().replace(/\\/g, "/");
  if (/^\/+$/.test(slashed)) return "/";
  const trimmed = slashed.replace(/\/+$/, "");
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/** MCP override saved for a folder, or undefined when the folder has none. */
export function mcpFolderConfig(
  settings: { mcpFolderConfigs?: Record<string, McpFolderConfig> } | null | undefined,
  cwd: string | null | undefined,
): McpFolderConfig | undefined {
  const key = canonicalCwd(cwd);
  if (!key) return undefined;
  return settings?.mcpFolderConfigs?.[key];
}

/**
 * Attachment state of one MCP server inside a folder: the folder's explicit
 * switch wins, otherwise the server's own `enabled` flag (for a server found
 * in a folder MCP file: the file's own `enabled`).
 */
export function mcpServerInFolder(
  config: McpFolderConfig | undefined,
  server: McpServerConfig,
): boolean {
  return config?.overrides?.[server.id] ?? Boolean(server.enabled);
}

/**
 * Folder MCP files read for every chat by default, relative to the chat's own
 * cwd — the per-project conventions tools already write there. Configurable in
 * Settings → MCP; an empty list turns folder files off entirely.
 */
export const DEFAULT_MCP_PROJECT_FILES: readonly string[] = [
  ".omp/mcp.json",
  ".cursor/mcp.json",
  ".agents/mcp.json",
];

/**
 * Configured folder MCP files: trimmed, forward-slashed, de-duplicated.
 * Absolute paths and paths escaping the folder are dropped — the list may only
 * point inside the chat's own cwd. A non-array (absent setting) means defaults.
 */
export function normalizeMcpProjectFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return [...DEFAULT_MCP_PROJECT_FILES];
  const out: string[] = [];
  for (const raw of files) {
    if (typeof raw !== "string") continue;
    const path = raw
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, "/");
    if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) continue;
    if (path.split("/").some((seg) => seg === "..")) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * Folders the built-in agent scans for skills (a skill is a subfolder with a
 * `SKILL.md`), relative to the chat's own cwd; `~` names the server user's
 * home and absolute paths name other global collections. Configurable in
 * Settings → Built-in agent; an empty list turns skill discovery off.
 */
export const DEFAULT_BUILTIN_SKILL_PATHS: readonly string[] = [".agents/skills"];

/**
 * Configured skill folders: trimmed, forward-slashed, de-duplicated. `~`- and
 * absolute paths are kept — the list exists precisely to point at a global
 * collection such as `~/.agents/skills`. Relative paths may not escape the
 * chat's cwd; a non-array (absent setting) means the default.
 */
export function normalizeSkillPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [...DEFAULT_BUILTIN_SKILL_PATHS];
  const out: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const trimmed = raw
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "");
    if (!trimmed) continue;
    const global = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("/") || /^[a-z]:/i.test(trimmed);
    if (!global && trimmed.split("/").some((seg) => seg === "..")) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

const MCP_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * `${VAR}` / `${VAR:-default}` expansion for values coming out of a folder MCP
 * file. Unresolved placeholders stay literal, and a variable set to an empty
 * string counts as unset (matching OMP's own non-empty rule).
 */
export function expandMcpVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(MCP_VAR_RE, (whole, name: string, fallback?: string) => {
    const found = env[name];
    if (found) return found;
    return fallback ?? whole;
  });
}

/** Folder MCP file parse result: ACP-ready servers plus human-readable problems. */
export type McpProjectFileResult = { servers: McpServerConfig[]; warnings: string[] };

/** One folder's discovered MCP servers, plus problems worth showing (API wire). */
export type ProjectMcpInfo = { servers: McpServerConfig[]; warnings: string[] };

/** String array from a JSON value, or undefined when the shape is wrong. */
function mcpStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === "string");
}

/** `{ name: value }` map from a JSON value as string rows (env / headers). */
function mcpNameValueRows(raw: unknown): Array<{ name: string; value: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rows: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim()) continue;
    if (typeof value === "object" && value !== null) continue;
    rows.push({ name, value: String(value ?? "") });
  }
  return rows.length ? rows : undefined;
}

/**
 * Parse one folder MCP file — the `{ "mcpServers": { name: … } }` convention
 * shared by OMP, Cursor and Claude Code. `${VAR}` placeholders are expanded
 * here (the ACP agent receives literal values), and ids are
 * `file:<path>:<name>` so a chat or its folder can switch a discovered server
 * off exactly like an app-configured one.
 */
export function parseMcpProjectFile(
  text: string,
  relPath: string,
  env: Record<string, string | undefined> = {},
): McpProjectFileResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { servers: [], warnings: [`${relPath}: invalid JSON`] };
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { servers: [], warnings: [`${relPath}: not a JSON object`] };
  }
  if (!("mcpServers" in root) || !root.mcpServers) {
    return { servers: [], warnings: [`${relPath}: missing "mcpServers" object`] };
  }
  const map = root.mcpServers;
  if (typeof map !== "object" || Array.isArray(map)) {
    return { servers: [], warnings: [`${relPath}: missing "mcpServers" object`] };
  }
  const ex = (value: string) => expandMcpVars(value, env);
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`${relPath}: server "${name}" is not an object`);
      continue;
    }
    const id = `file:${relPath}:${name}`;
    const enabled = !("enabled" in raw) || raw.enabled !== false;
    const command =
      "command" in raw && typeof raw.command === "string" ? ex(raw.command.trim()) : "";
    const url = "url" in raw && typeof raw.url === "string" ? ex(raw.url.trim()) : "";
    if (command && url) {
      warnings.push(`${relPath}: server "${name}" sets both "command" and "url"`);
      continue;
    }
    if (command) {
      servers.push({
        id,
        name,
        enabled,
        type: "stdio",
        command,
        args: "args" in raw ? mcpStringArray(raw.args)?.map(ex) : undefined,
        env:
          "env" in raw
            ? mcpNameValueRows(raw.env)?.map((row) => ({ name: row.name, value: ex(row.value) }))
            : undefined,
      });
      continue;
    }
    if (url) {
      const headers =
        "headers" in raw
          ? mcpNameValueRows(raw.headers)?.map((row) => ({
              name: row.name,
              value: ex(row.value),
            }))
          : undefined;
      if ("type" in raw && raw.type === "sse") {
        warnings.push(`${relPath}: server "${name}": sse is sent as http`);
      }
      servers.push({
        id,
        name,
        enabled,
        type: "remote",
        url,
        remoteConfig: headers?.length
          ? JSON.stringify({
              headers: Object.fromEntries(headers.map((row) => [row.name, row.value])),
            })
          : undefined,
      });
      continue;
    }
    warnings.push(`${relPath}: server "${name}" has neither "command" nor "url"`);
  }
  return { servers, warnings };
}

/**
 * MCP servers a chat actually gets: servers the app configures (minus the ones
 * its folder switched off, plus the ones its folder switched on — a folder may
 * attach a server that is off globally), then the folder's own servers, then
 * servers found in the folder's own MCP files, minus the ids the chat itself
 * disabled. Folder-specific servers are ordinary ids, so a chat can disable one
 * exactly like a global server.
 */
export function effectiveMcpServers(
  settings: AppSettings,
  disabledIds: string[] | null | undefined,
  cwd?: string | null,
  projectServers: McpServerConfig[] = [],
): McpServerConfig[] {
  const folder = mcpFolderConfig(settings, cwd);
  const disabledInChat = new Set(disabledIds ?? []);
  const out = (settings.mcpServers ?? []).filter(
    (s) => isMcpServerConfigured(s) && mcpServerInFolder(folder, s) && !disabledInChat.has(s.id),
  );
  for (const s of folder?.servers ?? []) {
    if (isMcpServerAttached(s) && !disabledInChat.has(s.id)) out.push(s);
  }
  // Folder files come last and never shadow a server configured in the app
  // (whether that one is attached or not): the attached list must not carry
  // two entries with the same ACP server name.
  const names = new Set(
    [...(settings.mcpServers ?? []), ...(folder?.servers ?? [])]
      .filter(isMcpServerConfigured)
      .map((s) => s.name),
  );
  for (const s of projectServers) {
    if (!isMcpServerConfigured(s) || !mcpServerInFolder(folder, s)) continue;
    if (disabledInChat.has(s.id)) continue;
    if (names.has(s.name)) continue;
    names.add(s.name);
    out.push(s);
  }
  return out;
}

export type Theme = "light" | "dark";
export type AppLocale = "ru" | "en";
export type PermissionPolicy = "prompt" | "allowlist" | "always";

/** Message action buttons under each message; fixed display order. */
export type ChatActionId =
  | "copy"
  | "edit"
  | "like"
  | "dislike"
  | "share"
  | "regenerate"
  | "readAloud";

/** Chips shown in the composer bar above the input. */
export type ChatMetaChipId =
  | "folder"
  | "board"
  | "gitBranch"
  | "gitChanges"
  | "thoughts"
  | "mcp"
  | "context"
  | "console";

/** Optional controls in the chat tree. Core actions (new chat, folder add)
 *  are always visible and cannot be hidden. */
export type ChatToolbarStyle = "classic" | "minimal";

/** How an empty board group invites a new task: a card-shaped placeholder,
 *  a quiet slim row, or nothing (the group's "+" still adds). */
export type BoardAddCardStyle = "card" | "compact" | "hidden";

/** Folder chip: how an over-long path shortens once the chip is compressed. */
export type ChatCwdTruncate = "middle" | "end";

/** Changes chip: what the chip shows next to its icon. */
export type ChatChangesMetrics = "none" | "lines" | "files" | "linesAndFiles";

/** Context chip: absolute token usage or the share of the context window. */
export type ChatContextFormat = "usage" | "percent";

/**
 * Per-chip options for the composer meta row. Each chip is configured on its
 * own: whether it may shrink when the row runs out of room, and what it shows.
 * A chip that cannot shrink (compress off, or already at its smallest) is the
 * one that moves into the "…" menu.
 */
export interface ChatChipOptions {
  folder: {
    /** Shrink the path instead of dropping the chip into the "…" menu. */
    compress: boolean;
    /** "middle" keeps the head and tail of the path, "end" only the tail. */
    truncate: ChatCwdTruncate;
  };
  gitBranch: { compress: boolean };
  gitChanges: {
    compress: boolean;
    /** "-" … "+" line counts, the changed-file count, both, or nothing. */
    metrics: ChatChangesMetrics;
  };
  context: { format: ChatContextFormat };
}

export const DEFAULT_CHAT_CHIP_OPTIONS: ChatChipOptions = {
  folder: { compress: true, truncate: "middle" },
  gitBranch: { compress: true },
  gitChanges: { compress: true, metrics: "linesAndFiles" },
  context: { format: "usage" },
};

export type ChatTreeElementId = "search" | "searchMsgs" | "pin" | "archive" | "more";

/** Commands shown inside the session "⋯" context menu in the tree.
 *  Pin/archive live on the row buttons and are configured separately. */
export type ChatTreeMenuId = "rename" | "move" | "export" | "delete";

/** Icons in the app header bar (language, install, theme). */
export type ChatHeaderIconId = "lang" | "install" | "theme";

/** Optional buttons in the composer bar. The input and send button are
 *  always visible. */
export type ChatComposerButtonId = "attach" | "mic" | "model" | "mode";

/** Where the composer's attach button looks for a file by default.
 *  "device" — the browser's device (uploaded into the session folder);
 *  "server" — the filesystem of the machine running the server. */
export type AttachSource = "device" | "server";

export type MessagePartType =
  | "text"
  | "thought"
  | "tool_call"
  | "plan"
  | "todo"
  | "subagent"
  | "permission"
  | "question"
  | "error"
  | "status"
  | "file";

export type SessionStatus = "idle" | "running" | "waiting" | "error" | "closed";

/** Kanban board workspace: own folders, own tasks, isolated from the chat tree. */
export interface BoardDto {
  id: string;
  name: string;
  /** Folder paths (projects) in display order — doubles as the Todo group order. */
  folders: string[];
  /** Tags (short notes) of the board's folders, keyed by canonical cwd. */
  folderTags: Record<string, string>;
  /**
   * Folders whose tasks are started one after another, keyed by canonical cwd.
   * A folder waits for its running task to stop before starting the next Todo
   * card, so its tasks run top to bottom on their own. Only switched-on folders
   * appear, so the map stays sparse.
   */
  folderAutoRun: Record<string, boolean>;
  sortOrder: number;
  createdAt: string;
}

/** Board columns are derived from the session row, never stored. */
export type BoardColumn = "todo" | "progress" | "wait" | "done";

/**
 * Map a board task to its column. Derivation, in order:
 *  - doneAt set               → done   (user closed the task)
 *  - running                  → progress (agent turn is live)
 *  - waiting | error | closed → wait   (needs the user's attention)
 *  - idle, no startedAt       → todo   (created, work never started)
 *  - idle, startedAt          → wait   (turn finished, awaiting the user)
 */
export function boardColumn(s: {
  status: SessionStatus;
  startedAt: string | null;
  doneAt: string | null;
}): BoardColumn {
  if (s.doneAt) return "done";
  if (s.status === "running") return "progress";
  if (s.status !== "idle") return "wait";
  return s.startedAt ? "wait" : "todo";
}

/** Windows shell for the in-app session terminal. */
export type TerminalShell = "cmd" | "powershell";

/**
 * One model the built-in agent can talk to (Settings → Built-in agent).
 * The agent needs no catalog service, so the list is plain settings data.
 */
export interface BuiltinModelConfig {
  /** Provider wire id sent to the endpoint (e.g. `gpt-5.2`, `qwen3-coder`). */
  id: string;
  /** Label shown in the model picker. */
  label: string;
  /** Context window in tokens — drives the context chip and history pruning. */
  contextWindow: number;
  /**
   * Whether the model is offered in pickers. Absent = enabled (rows written
   * before this flag existed). Disabled rows are kept so their label/window
   * edits and hand-added models survive a re-fetch of the catalog.
   */
  enabled?: boolean;
  /**
   * Whether the user typed the window themselves. A window the sources
   * reported (endpoint, model registry) is refreshed on re-fetch; a typed one
   * is an override and survives.
   */
  contextWindowEdited?: boolean;
}

/**
 * A model the built-in agent's endpoint advertises over `GET /models`.
 * `label`/`contextWindow` stay undefined when the API does not report them.
 */
export interface DiscoveredBuiltinModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

/** Context window assumed for a model row that does not state one. */
export const BUILTIN_FALLBACK_CONTEXT_WINDOW = 128_000;
const BUILTIN_MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * Heal one provider's model rows: blank/duplicate ids dropped, labels and
 * context windows sane. Switched-off rows are kept — their edits, their
 * hand-added ids and a chat pinned to them must still resolve a window.
 */
export function normalizeBuiltinModelRows(rows: unknown): BuiltinModelConfig[] {
  const out: BuiltinModelConfig[] = [];
  if (!Array.isArray(rows)) return out;
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "").trim().slice(0, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const raw = Math.round(Number(r.contextWindow) || 0);
    const window =
      raw > 0 ? Math.min(raw, BUILTIN_MAX_CONTEXT_WINDOW) : BUILTIN_FALLBACK_CONTEXT_WINDOW;
    out.push({
      id,
      label: String(r.label ?? "").trim().slice(0, 120) || id,
      contextWindow: window,
      ...(r.enabled === false ? { enabled: false as const } : {}),
      ...(r.contextWindowEdited === true ? { contextWindowEdited: true as const } : {}),
    });
  }
  return out;
}

/**
 * One extra HTTP header the built-in agent sends with every request to a
 * provider (Settings → Built-in agent). A value may carry the `{{sessionId}}`
 * placeholder — replaced with the ACP session id at request time.
 */
export interface BuiltinHeaderConfig {
  name: string;
  value: string;
}

/** Cap on header rows kept per provider (protects settings size). */
const BUILTIN_MAX_HEADERS = 50;

/**
 * Heal one provider's header rows: nameless rows dropped, lengths capped. A
 * row with a name but an empty value is kept — some endpoints key on presence.
 */
export function normalizeBuiltinHeaderRows(rows: unknown): BuiltinHeaderConfig[] {
  const out: BuiltinHeaderConfig[] = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows.slice(0, BUILTIN_MAX_HEADERS)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = String(r.name ?? "").trim().slice(0, 200);
    if (!name) continue;
    out.push({ name, value: String(r.value ?? "").slice(0, 2000) });
  }
  return out;
}

/**
 * A provider's extra headers as a flat map ready for `fetch` and the OpenAI
 * SDK. `{{sessionId}}` in a value becomes the given session id; called without
 * one (the /models probe, where no session exists), rows carrying the
 * placeholder are dropped — half a session id helps no endpoint.
 */
export function builtinProviderHeaders(
  headers: readonly BuiltinHeaderConfig[] | undefined,
  sessionId?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of headers ?? []) {
    if (sessionId === undefined && row.value.includes("{{sessionId}}")) continue;
    out[row.name] = row.value.replaceAll("{{sessionId}}", sessionId ?? "");
  }
  return out;
}

/**
 * One OpenAI-compatible endpoint the built-in agent may talk to (Settings →
 * Built-in agent): its own URL, key and model list. Several providers may
 * coexist — a model is addressed as `<provider id>::<model id>` so the same
 * wire id offered by two endpoints stays selectable on both.
 */
export interface BuiltinProviderConfig {
  /** Stable machine id (never shown) — the prefix of composite model values. */
  id: string;
  /** Display name shown next to model labels in pickers. */
  name: string;
  /** Base URL of an OpenAI-compatible API; empty = provider switched off. */
  url: string;
  /** Sent as a Bearer token ("" for local endpoints that need no key). */
  apiKey: string;
  /** Models this provider exposes in the agent's picker. */
  models: BuiltinModelConfig[];
  /** Extra HTTP headers sent with every request to this provider. */
  headers?: BuiltinHeaderConfig[];
}

/** Separator inside a composite built-in model value: `<provider>::<model>`. */
export const BUILTIN_MODEL_SEPARATOR = "::";

/** Composite picker value for one provider's model. */
export function builtinModelValue(providerId: string, modelId: string): string {
  return `${providerId}${BUILTIN_MODEL_SEPARATOR}${modelId}`;
}

/**
 * Split a picked/stored value. Only a prefix that names a known provider
 * counts: a bare id (written before providers existed, or by a pinned chat)
 * comes back with `providerId: ""` and must be resolved against the models.
 */
export function parseBuiltinModelValue(
  value: string,
  providers: readonly { id: string }[],
): { providerId: string; modelId: string } {
  const raw = value.trim();
  const cut = raw.indexOf(BUILTIN_MODEL_SEPARATOR);
  if (cut > 0 && providers.some((p) => p.id === raw.slice(0, cut))) {
    return {
      providerId: raw.slice(0, cut),
      modelId: raw.slice(cut + BUILTIN_MODEL_SEPARATOR.length),
    };
  }
  return { providerId: "", modelId: raw };
}

/**
 * Read-time upgrade of the built-in agent settings, applied by both the
 * server merge and the client merge:
 *
 * - folds the pre-provider fields (`builtinAgentUrl`/`builtinAgentApiKey`/
 *   `builtinModels`) into one provider row and drops them from the object;
 * - heals provider rows (id-less/duplicate rows dropped, models normalized);
 * - rewrites stored builtin model values (default, recents, favorites, params)
 *   from bare ids to composite `<provider>::<model>` where they resolve.
 *
 * Accepts the whole settings object because legacy keys and the model maps
 * live next to the provider list; `settings` may be null/non-object.
 */
export function normalizeBuiltinProviders(settings: unknown): BuiltinProviderConfig[] {
  const raw = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;

  const hasLegacy =
    "builtinAgentUrl" in raw || "builtinAgentApiKey" in raw || "builtinModels" in raw;
  if (
    hasLegacy &&
    (!Array.isArray(raw.builtinProviders) || raw.builtinProviders.length === 0)
  ) {
    const url = typeof raw.builtinAgentUrl === "string" ? raw.builtinAgentUrl.trim() : "";
    const apiKey = typeof raw.builtinAgentApiKey === "string" ? raw.builtinAgentApiKey.trim() : "";
    const models = normalizeBuiltinModelRows(raw.builtinModels);
    if (url || apiKey || models.length) {
      raw.builtinProviders = [
        {
          id: "legacy",
          name: raw.locale === "ru" ? "Основной" : "Default",
          url: url.slice(0, 500),
          apiKey: apiKey.slice(0, 500),
          models,
        },
      ];
    }
  }
  delete raw.builtinAgentUrl;
  delete raw.builtinAgentApiKey;
  delete raw.builtinModels;

  const providers = healBuiltinProviders(raw.builtinProviders);
  rewriteBuiltinModelValues(raw, providers);
  raw.builtinProviders = providers;
  return providers;
}

/** Heal stored provider rows: id-less/duplicate rows drop, models normalized. */
export function healBuiltinProviders(raw: unknown): BuiltinProviderConfig[] {
  const out: BuiltinProviderConfig[] = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim().slice(0, 64) : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
    const url = typeof r.url === "string" ? r.url.trim().slice(0, 500) : "";
    const headers = normalizeBuiltinHeaderRows(r.headers);
    out.push({
      id,
      name: name || url || id,
      url,
      apiKey: typeof r.apiKey === "string" ? r.apiKey.trim().slice(0, 500) : "",
      models: normalizeBuiltinModelRows(r.models),
      // Conditional: settings written before headers existed keep their shape.
      ...(headers.length ? { headers } : {}),
    });
  }
  return out;
}

/**
 * Resolve a bare legacy value to its composite form (first provider offering
 * that model id wins). Already-composite or unresolvable values pass through.
 */
function toCompositeBuiltinValue(
  value: string,
  providers: readonly BuiltinProviderConfig[],
): string {
  const parsed = parseBuiltinModelValue(value, providers);
  if (parsed.providerId) return value;
  const host = providers.find((p) => p.models.some((m) => m.id === parsed.modelId));
  return host ? builtinModelValue(host.id, parsed.modelId) : value;
}

/** Map + dedupe a per-builtin model list (recents, favorites). */
function rewriteBuiltinModelList(
  values: unknown,
  providers: readonly BuiltinProviderConfig[],
): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const next = toCompositeBuiltinValue(raw, providers);
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

/** Rewrite the builtin buckets of the stored model maps in place. */
function rewriteBuiltinModelValues(
  raw: Record<string, unknown>,
  providers: readonly BuiltinProviderConfig[],
): void {
  const byProvider = (key: string): Record<string, unknown> => {
    const current = raw[key];
    return current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  };

  const defaultMap = byProvider("defaultModelByProvider");
  if (typeof defaultMap.builtin === "string" && defaultMap.builtin) {
    defaultMap.builtin = toCompositeBuiltinValue(defaultMap.builtin, providers);
  }
  raw.defaultModelByProvider = defaultMap;

  for (const key of ["recentModelsByProvider", "favoriteModelsByProvider"] as const) {
    const map = byProvider(key);
    const rewritten = rewriteBuiltinModelList(map.builtin, providers);
    if (rewritten) map.builtin = rewritten;
    raw[key] = map;
  }

  const paramsMap = byProvider("modelParamsByProviderModel");
  if (paramsMap.builtin && typeof paramsMap.builtin === "object" && !Array.isArray(paramsMap.builtin)) {
    const bucket: Record<string, unknown> = {};
    for (const [model, params] of Object.entries(paramsMap.builtin as Record<string, unknown>)) {
      bucket[toCompositeBuiltinValue(model, providers)] = params;
    }
    paramsMap.builtin = bucket;
  }
  raw.modelParamsByProviderModel = paramsMap;
}

/** Tool names the built-in agent can grant to a subagent. */
export const BUILTIN_TOOL_NAMES = ["read", "glob", "grep", "write", "edit", "bash"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** Default and hard cap for one subagent run's step budget. */
export const BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT = 30;
export const BUILTIN_SUBAGENT_MAX_TURNS_CAP = 60;
/** Hard cap on user-defined subagent rows. */
export const BUILTIN_SUBAGENT_AGENTS_MAX = 20;

/**
 * One named subagent the built-in `task` tool can spawn. The built-in
 * `explore` agent is code, not settings — only user-defined rows are stored.
 */
export interface BuiltinSubagentDef {
  /** Stable machine id (never shown). */
  id: string;
  /** Name the model addresses the agent by (`task { agent: "<name>" }`). */
  name: string;
  /** When to use this agent — surfaced to the model in the roster. */
  description: string;
  /** Child run's system prompt; the report contract is appended to it. */
  systemPrompt: string;
  /** Tools the child may use — intersected with the parent's own toolset. */
  tools: BuiltinToolName[];
  /** Step ceiling for one child run (hard cap: BUILTIN_SUBAGENT_MAX_TURNS_CAP). */
  maxTurns: number;
}

export interface BuiltinSubagentsSetting {
  /** Master switch: exposes the `task` tool and the prompt section when on. */
  enabled: boolean;
  /** Let the model compose ad-hoc children (its own systemPrompt + tools). */
  allowAdhoc: boolean;
  /** User-defined agents; ids/names are deduped, `task`/`explore` reserved. */
  agents: BuiltinSubagentDef[];
}

export const DEFAULT_BUILTIN_SUBAGENTS: BuiltinSubagentsSetting = {
  enabled: false,
  allowAdhoc: true,
  agents: [],
};

const BUILTIN_SUBAGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Names the model cannot claim for a user-defined agent. */
const BUILTIN_SUBAGENT_RESERVED_NAMES = ["task", "explore"];

function healBuiltinSubagentRow(raw: unknown): BuiltinSubagentDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim().slice(0, 64) : "";
  // Slugify what the user typed ("Test Runner" -> "test_runner"); a name that
  // still fails the model-facing shape drops the row.
  const name =
    typeof r.name === "string"
      ? r.name
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "_")
          .replace(/[^a-z0-9_-]/g, "")
          .replace(/^_+|_+$/g, "")
          .slice(0, 32)
      : "";
  if (!id || !BUILTIN_SUBAGENT_NAME_RE.test(name)) return null;
  const tools = [
    ...new Set(
      Array.isArray(r.tools)
        ? r.tools.filter(
            (t): t is BuiltinToolName =>
              typeof t === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(t),
          )
        : [],
    ),
  ];
  const maxTurns =
    typeof r.maxTurns === "number" && Number.isFinite(r.maxTurns)
      ? Math.min(BUILTIN_SUBAGENT_MAX_TURNS_CAP, Math.max(1, Math.round(r.maxTurns)))
      : BUILTIN_SUBAGENT_MAX_TURNS_DEFAULT;
  return {
    id,
    name,
    description: typeof r.description === "string" ? r.description.trim().slice(0, 500) : "",
    systemPrompt: typeof r.systemPrompt === "string" ? r.systemPrompt.slice(0, 8000) : "",
    tools,
    maxTurns,
  };
}

/**
 * Heal the stored builtin-subagents setting, applied by both the server merge
 * and the client merge: malformed rows drop, ids/names dedupe (the model-facing
 * `task` and the built-in `explore` names are reserved), caps clamp.
 */
export function normalizeBuiltinSubagents(value: unknown): BuiltinSubagentsSetting {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const agents: BuiltinSubagentDef[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>(BUILTIN_SUBAGENT_RESERVED_NAMES);
  if (Array.isArray(raw.agents)) {
    for (const row of raw.agents) {
      if (agents.length >= BUILTIN_SUBAGENT_AGENTS_MAX) break;
      const healed = healBuiltinSubagentRow(row);
      if (!healed || seenIds.has(healed.id) || seenNames.has(healed.name)) continue;
      seenIds.add(healed.id);
      seenNames.add(healed.name);
      agents.push(healed);
    }
  }
  return {
    enabled: raw.enabled === true,
    allowAdhoc: raw.allowAdhoc !== false,
    agents,
  };
}

export interface AppSettings {
  theme: Theme;
  locale: AppLocale;
  /** Local display name shown in the header. */
  displayName: string;
  /** Agent explicitly connected in Settings → Connect. */
  connectedProvider: AgentProvider | null;
  defaultProvider: AgentProvider;
  /**
   * Harnesses switched off in Settings → Connect: never probed, never offered
   * in agent pickers/forms. Sessions that already use them stay readable.
   */
  disabledProviders: AgentProvider[];
  defaultMode: AgentMode;
  defaultCwd: string;
  defaultModel: string;
  /** Cursor ACP parameterized picker values (fast, effort, context, …). */
  defaultModelParams: Record<string, string>;
  /** Default model id per harness (Models settings + new chats). */
  defaultModelByProvider: Partial<Record<AgentProvider, string>>;
  /** Parameter picker values per harness. */
  defaultModelParamsByProvider: Partial<Record<AgentProvider, Record<string, string>>>;
  /** Explicitly picked params per model (provider → model → params); overrides the provider default. */
  modelParamsByProviderModel: Partial<Record<AgentProvider, Record<string, Record<string, string>>>>;
  /** Last used models per harness, newest first. */
  recentModelsByProvider: Partial<Record<AgentProvider, string[]>>;
  /** Starred models per harness (right-click in the picker). */
  favoriteModelsByProvider: Partial<Record<AgentProvider, string[]>>;
  /** User-defined ACP agents (Settings → Connect) — registered at runtime. */
  customAgents: CustomAgentSpec[];
  cursorCommand: string;
  cursorArgs: string[];
  ompCommand: string;
  ompArgs: string[];
  cursorApiKey: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  /**
   * Endpoints the built-in agent may talk to — each with its own URL, key and
   * model list (Settings → Built-in agent). Empty = the agent stays offline.
   */
  builtinProviders: BuiltinProviderConfig[];
  permissionPolicy: PermissionPolicy;
  permissionAllowlist: string[];
  /** Folder on the server where diagnostic dumps are written. Empty → default under repo. */
  diagnosticsDir: string;
  /** Append verbose agent traffic logs (JSONL) into the diagnostics folder. */
  diagnosticsDeepLogging: boolean;
  /** Folder on the server where chat exports are written. Empty → default under repo. */
  exportDir: string;
  /**
   * Reuse the agent's ACP session on restarts (model/MCP change, server
   * restart): OMP via session/resume, Cursor via session/load. Keeps the
   * agent's context instead of starting each spawn with a blank slate.
   */
  resumeAgentContext: boolean;
  /**
   * Queue requests back-to-back (agent keeps working on the next one as soon
   * as the previous reply is done). Only meaningful for agents that support
   * multitasking (Cursor, OMP).
   */
  multitask: boolean;
  /**
   * How the sidebar tree behaves when collapsed:
   * "full" — hides completely (previous behavior);
   * "rail" — leaves a narrow icon rail (new chat, recents, find, expand).
   */
  sidebarCollapse: "full" | "rail";
  /** Show the animated boot splash on app start. */
  showBootSplash: boolean;
  /** Font family id ("" = default). */
  fontFamily: string;
  /** Root font-size id ("" = default). */
  fontSize: string;
  /** Light theme palette id ("" = default system palette). */
  lightScheme: string;
  /** Dark theme palette id ("" = default system palette). */
  darkScheme: string;
  /** Custom palette colors (accent/bg/surface) — used when the scheme is "custom". */
  lightAccent: string;
  lightBg: string;
  lightSurface: string;
  darkAccent: string;
  darkBg: string;
  darkSurface: string;
  /** Preferred read-aloud voice gender ("" = browser default). */
  ttsVoiceGender: "" | "female" | "male";
  /**
   * Message action buttons under each message, in display order. The first 5
   * enabled actions render as icons, the rest hide behind the "⋯" menu.
   */
  chatActions: ChatActionId[];
  /** Chips shown in the composer bar above the input. */
  chatMetaChips: ChatMetaChipId[];
  /** Thinking chip style in the composer bar. */
  thoughtsChipStyle: "full" | "icon";
  /** Console chip style in the composer bar. */
  consoleChipStyle: "full" | "icon";
  /** Default shell for the session terminal (Windows server only). */
  terminalShell: TerminalShell;
  /** Optional composer buttons (attach, mic, model, mode picker). */
  chatComposerButtons: ChatComposerButtonId[];
  /**
   * Which source the attach button opens on a plain click. Right-click opens
   * the other source. "device" (default) = the browser's device, "server" =
   * the machine running the server.
   */
  attachDefaultSource: AttachSource;
  /** Tree sidebar controls shown (search, per-row actions). */
  chatTreeElements: ChatTreeElementId[];
  /** Commands in the session "⋯" context menu. */
  chatTreeMenu: ChatTreeMenuId[];
  /** Show the "Archive" section in the chat tree. */
  chatTreeShowArchive: boolean;
  /**
   * How many of the newest chats stay visible per folder in the chat tree.
   * The rest hide behind a "Show more" button; 0 shows every chat.
   */
  chatTreeRecentLimit: number;
  /** App header height in px (drag the header in the preview). */
  chatHeaderHeight: number;
  /** Icons shown in the app header bar. */
  chatHeaderIcons: ChatHeaderIconId[];
  /** Enter sends the message; off → Enter inserts a newline, Ctrl+Enter sends. */
  chatEnterToSend: boolean;
  /** Show the send time next to each message. */
  chatShowMessageTime: boolean;
  /** Interleave thinking phases and actions (Cursor-style) instead of one steps spoiler. */
  chatAgentTurnTimeline: boolean;
  /** Desktop: allow two chats side by side. */
  chatSplit: boolean;
  /** New chat + search controls in the tree sidebar. */
  chatToolbarStyle: ChatToolbarStyle;
  /** Look of the "Add task" placeholder in empty board groups. */
  boardAddCardStyle: BoardAddCardStyle;
  /**
   * Agent picker in the board's new-task form. Off hides the control: the task
   * is created for the default agent, and the run menu can still pick another.
   */
  boardTaskAgentPicker: boolean;
  /** Position of the Git branch bar: "below" the input or "above" as a chip. */
  chatGitBranchPosition?: "below" | "above";
  /** Per-chip composer options: shrink behaviour and what each chip shows. */
  chatChipOptions: ChatChipOptions;
  /** Internal persisted settings schema version (not shown in UI). */
  settingsSchema?: number;
  /**
   * Optional shared key for opening the UI from a phone or another PC.
   * Empty = anyone on the VPN/LAN can connect. Localhost never asks.
   */
  remoteAccessKey: string;
  /** MCP servers attached to the agent (HTTP local/remote + stdio). */
  mcpServers: McpServerConfig[];
  /**
   * Per-folder MCP overrides, keyed by canonical cwd: which servers a folder
   * switches on or off (a globally disabled one included), plus servers that
   * exist only in that folder. Chats opened in the folder additionally apply
   * their own `mcpDisabledIds`.
   */
  mcpFolderConfigs: Record<string, McpFolderConfig>;
  /**
   * Folder MCP files read for every chat, relative to the chat's own cwd
   * (`DEFAULT_MCP_PROJECT_FILES` unless changed). Servers found there attach
   * like app-configured ones; an empty list ignores folder files entirely.
   */
  mcpProjectFiles: string[];
  /**
   * Folders the built-in agent scans for skills (`DEFAULT_BUILTIN_SKILL_PATHS`
   * unless changed): each subfolder carrying a `SKILL.md` becomes a skill the
   * agent announces and follows. Relative paths resolve per chat cwd, absolute
   * ones are global; an empty list disables skills.
   */
  builtinSkillPaths: string[];
  /**
   * Built-in agent subagents: the master switch plus user-defined named agents
   * for the `task` tool (the built-in `explore` agent is not stored here).
   */
  builtinSubagents: BuiltinSubagentsSetting;
  /**
   * Composer drafts persisted so typed text survives a reload, keyed by chat id.
   * Empty values are pruned server-side; a chat's draft is dropped when it is
   * deleted or its message is sent.
   */
  composerDrafts: Record<string, string>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  locale: "en",
  displayName: "",
  connectedProvider: null,
  defaultProvider: "cursor",
  disabledProviders: [],
  defaultMode: "agent",
  defaultCwd: "",
  defaultModel: "",
  defaultModelParams: {},
  defaultModelByProvider: {},
  defaultModelParamsByProvider: {},
  modelParamsByProviderModel: {},
  recentModelsByProvider: {},
  favoriteModelsByProvider: {},
  customAgents: [],
  cursorCommand: "agent",
  cursorArgs: ["acp"],
  ompCommand: "omp",
  ompArgs: ["acp"],
  cursorApiKey: "",
  anthropicApiKey: "",
  openaiApiKey: "",
  builtinProviders: [],
  permissionPolicy: "always",
  permissionAllowlist: [],
  diagnosticsDir: "",
  diagnosticsDeepLogging: false,
  exportDir: "",
  resumeAgentContext: true,
  multitask: false,
  sidebarCollapse: "full",
  showBootSplash: true,
  fontFamily: "",
  fontSize: "",
  lightScheme: "",
  darkScheme: "",
  lightAccent: "",
  lightBg: "",
  lightSurface: "",
  darkAccent: "",
  darkBg: "",
  darkSurface: "",
  ttsVoiceGender: "",
  chatActions: ["copy", "edit", "like", "dislike", "share", "regenerate", "readAloud"],
  chatMetaChips: ["folder", "board", "gitBranch", "gitChanges", "thoughts", "mcp", "context", "console"],
  thoughtsChipStyle: "full",
  consoleChipStyle: "full",
  terminalShell: "cmd",
  chatComposerButtons: ["attach", "mic", "model", "mode"],
  attachDefaultSource: "device",
  chatTreeElements: ["search", "searchMsgs", "pin", "archive", "more"],
  chatTreeMenu: ["rename", "move", "export", "delete"],
  chatTreeShowArchive: true,
  chatTreeRecentLimit: 0,
  chatHeaderHeight: 52,
  chatHeaderIcons: ["lang", "install", "theme"],
  chatEnterToSend: true,
  chatShowMessageTime: false,
  chatAgentTurnTimeline: false,
  chatSplit: true,
  chatToolbarStyle: "classic",
  boardAddCardStyle: "card",
  boardTaskAgentPicker: true,
  chatGitBranchPosition: "below",
  chatChipOptions: DEFAULT_CHAT_CHIP_OPTIONS,
  remoteAccessKey: "",
  mcpServers: [],
  mcpFolderConfigs: {},
  mcpProjectFiles: [...DEFAULT_MCP_PROJECT_FILES],
  builtinSkillPaths: [...DEFAULT_BUILTIN_SKILL_PATHS],
  builtinSubagents: DEFAULT_BUILTIN_SUBAGENTS,
  composerDrafts: {},
};

export function modelForProvider(
  settings: AppSettings,
  provider: AgentProvider | null | undefined,
): string {
  if (!provider) return settings.defaultModel ?? "";
  const mapped = settings.defaultModelByProvider?.[provider];
  if (mapped) return mapped;
  if (settings.defaultProvider === provider) return settings.defaultModel ?? "";
  return "";
}

export function modelForSession(
  settings: AppSettings,
  session: { provider: AgentProvider; model?: string | null } | null | undefined,
): string {
  const pinned = session?.model?.trim();
  if (pinned) return pinned;
  return modelForProvider(settings, session?.provider);
}

export function modelParamsForProvider(
  settings: AppSettings,
  provider: AgentProvider | null | undefined,
): Record<string, string> {
  if (!provider) return settings.defaultModelParams ?? {};
  const mapped = settings.defaultModelParamsByProvider?.[provider];
  if (mapped) return mapped;
  if (settings.defaultProvider === provider) return settings.defaultModelParams ?? {};
  return {};
}

export function modelParamsForSession(
  settings: AppSettings,
  session: { provider: AgentProvider; modelParams?: Record<string, string> | null } | null | undefined,
): Record<string, string> {
  const pinned = session?.modelParams;
  if (pinned && Object.keys(pinned).length) return pinned;
  return modelParamsForProvider(settings, session?.provider);
}

/** Cap for the recent-models history kept per harness. */
export const RECENT_MODELS_LIMIT = 8;

/** Explicitly picked params for one model, if the user ever set them. */
export function savedModelParamsForModel(
  settings: AppSettings,
  provider: AgentProvider | null | undefined,
  model: string,
): Record<string, string> | undefined {
  if (!provider || !model) return undefined;
  return settings.modelParamsByProviderModel?.[provider]?.[model];
}

/**
 * Params a model should run with when it gets selected: provider default first,
 * explicitly picked per-model values on top, both alias-migrated onto the
 * schema the agent currently exposes for that model.
 */
export function resolveParamsForModel(
  settings: AppSettings,
  provider: AgentProvider | null | undefined,
  model: string,
  exposed: Array<{ id: string; options?: Array<{ value: string }>; currentValue?: string }>,
): Record<string, string> {
  const base = migrateModelParamValues(modelParamsForProvider(settings, provider), exposed);
  const explicit = savedModelParamsForModel(settings, provider, model);
  if (!explicit || Object.keys(explicit).length === 0) return base;
  const merged = { ...base, ...migrateModelParamValues(explicit, exposed) };
  return merged;
}

/** Push `model` to the head of a per-provider model list, deduped and capped. */
export function pushRecentModel(list: string[] | undefined, model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) return list ?? [];
  const rest = (list ?? []).filter((m) => m !== trimmed);
  return [trimmed, ...rest].slice(0, RECENT_MODELS_LIMIT);
}

/** Billing / credits failure from OMP when a model cannot be used. */
export function isModelAccessError(message: string): boolean {
  return /Insufficient balance|CreditsError|insufficient.?credits|payment required|billing/i.test(
    message,
  );
}

/** OMP pi-natives JS/Rust mismatch — common with DeepSeek/Qwen tokenizer models on stale `.node` builds. */
export function isTokenizerEncodingError(message: string): boolean {
  return /does not match any variant of enum [`']Encoding[`']|Unknown encoding|unknown tokenizer/i.test(
    message,
  );
}

export function tokenizerEncodingErrorHint(locale: "en" | "ru" = "en"): string {
  if (locale === "ru") {
    return (
      "Устаревший native-модуль pi-natives: JS ожидает токенизатор (DeepSeekV3 и др.), а загруженный `.node` его не поддерживает. " +
      "Обнови OMP (`bun install -g @oh-my-pi/pi-coding-agent@latest`) и в Настройках укажи `omp` + `acp`, " +
      "либо пересобери natives в dev-клоне OMP (`bun --cwd=packages/natives run build`). " +
      "Временный обходной путь — модель без deepseek-v3/qwen3 токенизатора."
    );
  }
  return (
    "Stale pi-natives binary: JS expects a tokenizer (DeepSeekV3, etc.) that the loaded `.node` does not support. " +
    "Update OMP (`bun install -g @oh-my-pi/pi-coding-agent@latest`) and set Settings to `omp` + `acp`, " +
    "or rebuild natives in a dev OMP clone (`bun --cwd=packages/natives run build`). " +
    "Workaround: pick a model that does not use the deepseek-v3/qwen3 tokenizer."
  );
}

/** Human-readable model label; keeps wire id unchanged. */
export function modelDisplayName(value: string, name?: string, defaultLabel = "Default"): string {
  const raw = (value || "").trim();
  const lower = raw.toLowerCase();
  if (
    lower === "default" ||
    lower === "default[]" ||
    lower.startsWith("default[") ||
    lower === "auto"
  ) {
    return defaultLabel;
  }

  const provided = (name || "").trim();
  // An opaque id carries no display information: ZCode spells its model as the
  // JSON tuple `["builtin:zai-coding-plan","GLM-5.3-Flash",null]`, which
  // humanizes into noise. There the agent's own title is authoritative.
  if (raw && !/^[\w./@-]+(?:\[[^\]]*\])?$/.test(raw)) {
    if (provided) {
      return isRawWireSlug(provided) ? prettifyModelWireId(provided, defaultLabel) : provided;
    }
    // A JSON tuple id (ZCode: `["builtin:zai-coding-plan","GLM-5.3-Flash",null]`)
    // still names its model: take the part that is not a provider marker.
    const parts = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    const model = parts.find((p) => p !== "" && !p.includes(":"));
    if (model) return prettifyModelWireId(model, defaultLabel);
    // A built-in composite `<provider id>::<model id>` (no catalog row to supply
    // the label yet): the provider id is internal, so show the model part.
    const cut = raw.lastIndexOf(BUILTIN_MODEL_SEPARATOR);
    const tail = cut > 0 ? raw.slice(cut + BUILTIN_MODEL_SEPARATOR.length).trim() : "";
    return tail ? prettifyModelWireId(tail, defaultLabel) : raw;
  }
  // Prefer a clean agent-provided title (e.g. "Cursor Grok 4.5 Fast").
  if (provided && !hasModelParams(provided) && !isRawWireSlug(provided)) {
    if (/^default(\[.*\])?$/i.test(provided) || /^auto$/i.test(provided)) return defaultLabel;
    return provided;
  }

  return prettifyModelWireId(raw || provided, defaultLabel);
}

/** Provider key embedded in an agent model value: `zai/glm-5.2` -> `zai`. Undefined for bare ids. */
export function modelProviderFromValue(value: string): string | undefined {
  const raw = (value || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  const prefix = raw.slice(0, slash).trim();
  const rest = raw.slice(slash + 1).trim();
  if (!prefix || !rest || /\s/.test(prefix)) return undefined;
  return prefix;
}

/**
 * Model id without its provider prefix: `zai/glm-5.2` -> `glm-5.2`. Bare ids
 * and prefixless values pass through whole, so `gpt-5.2` matches `openai/gpt-5.2`
 * but two prefixed values only match when the trailing id matches. Undefined
 * only for empty input.
 */
export function modelIdFromValue(value: string): string | undefined {
  const { base } = parseModelWire(value);
  if (!base) return undefined;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) return base;
  return base.slice(slash + 1).trim() || base;
}

function hasModelParams(label: string): boolean {
  return /\[[^\]]*[=:][^\]]*\]/.test(label);
}

function isRawWireSlug(label: string): boolean {
  // slug-like: no spaces, mostly lowercase/digits/dashes, optional params
  return /^[a-z0-9][a-z0-9._/-]*(?:\[[^\]]*\])?$/i.test(label) && !/\s/.test(label);
}

function prettifyModelWireId(wire: string, defaultLabel = "Default"): string {
  if (!wire) return defaultLabel;
  if (/^default(\[.*\])?$/i.test(wire) || /^auto$/i.test(wire)) return defaultLabel;

  const match = wire.match(/^([^[\]]+?)\s*\[([^\]]*)\]\s*$/);
  const base = (match?.[1] ?? wire).trim();
  const params = match?.[2] ?? "";
  const extras = formatModelParams(params);
  const baseLabel = humanizeModelBase(base);

  if (!extras.length) return baseLabel;
  const filtered = extras.filter((part) => {
    const p = part.toLowerCase();
    const b = baseLabel.toLowerCase();
    return !b.includes(p) && !(p === "fast" && /-?fast$/i.test(base));
  });
  return filtered.length ? `${baseLabel} · ${filtered.join(" · ")}` : baseLabel;
}

/** Cursor (and others) rename the same knob per model: effort ↔ reasoning ↔ thinking. */
const EFFORT_PARAM_IDS = new Set([
  "effort",
  "reasoning",
  "thinking",
  "thought_level",
  "reasoning_effort",
]);
const FAST_PARAM_IDS = new Set(["fast", "fast_mode"]);
const CONTEXT_PARAM_IDS = new Set(["context", "context_size"]);

export type ModelParamFamily = "fast" | "effort" | "context";

export function modelParamFamily(id: string): ModelParamFamily | null {
  const key = id.trim().toLowerCase();
  if (FAST_PARAM_IDS.has(key)) return "fast";
  if (EFFORT_PARAM_IDS.has(key)) return "effort";
  if (CONTEXT_PARAM_IDS.has(key)) return "context";
  return null;
}

const EFFORT_VALUE_ALIASES: Record<string, string[]> = {
  none: ["none", "off", "0", "false"],
  low: ["low"],
  medium: ["medium", "med"],
  high: ["high"],
  "extra-high": ["extra-high", "xhigh", "extra_high", "extrahigh"],
  xhigh: ["xhigh", "extra-high", "extra_high", "extrahigh"],
  max: ["max"],
};

/** Map a stored effort value onto an option list the agent currently exposes. */
export function mapEffortParamValue(value: string, allowed?: string[]): string {
  const raw = value.trim();
  if (!raw) return raw;
  if (!allowed?.length) return raw;
  if (allowed.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const allowedLower = new Map(allowed.map((v) => [v.toLowerCase(), v]));
  if (allowedLower.has(lower)) return allowedLower.get(lower)!;
  for (const [canonical, aliases] of Object.entries(EFFORT_VALUE_ALIASES)) {
    if (aliases.includes(lower) || canonical === lower) {
      for (const alias of [canonical, ...aliases]) {
        const hit = allowedLower.get(alias);
        if (hit) return hit;
      }
    }
  }
  // Don't send a value the agent doesn't expose (breaks mid-session model switches).
  return "";
}

/** Resolve a value for an exposed config option id from a loose params map (alias-aware). */
export function resolveModelParamValue(
  optId: string,
  params: Record<string, string>,
  allowedValues?: string[],
): string | undefined {
  const direct = params[optId];
  if (direct != null && direct !== "") {
    return modelParamFamily(optId) === "effort"
      ? mapEffortParamValue(direct, allowedValues)
      : direct;
  }
  const family = modelParamFamily(optId);
  if (!family) return undefined;
  for (const [key, value] of Object.entries(params)) {
    if (value === "" || modelParamFamily(key) !== family) continue;
    return family === "effort" ? mapEffortParamValue(value, allowedValues) : value;
  }
  return undefined;
}

/**
 * Re-key stored params onto currently exposed option ids (effort→reasoning, etc.).
 * Drops families the agent no longer exposes (e.g. Composer without Effort).
 */
export function migrateModelParamValues(
  params: Record<string, string>,
  exposed: Array<{ id: string; options?: Array<{ value: string }>; currentValue?: string }>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const opt of exposed) {
    const allowed = opt.options?.map((o) => o.value);
    const value = resolveModelParamValue(opt.id, params, allowed);
    if (value != null && value !== "") next[opt.id] = value;
    else if (opt.currentValue != null && opt.currentValue !== "") next[opt.id] = String(opt.currentValue);
  }
  return next;
}

function formatModelParams(params: string): string[] {
  if (!params.trim()) return [];
  const out: string[] = [];
  for (const piece of params.split(",")) {
    const [rawKey, ...rest] = piece.split("=");
    const key = (rawKey ?? "").trim().toLowerCase();
    const val = rest.join("=").trim().toLowerCase();
    if (!key) continue;
    if (modelParamFamily(key) === "fast") {
      if (val === "true" || val === "1" || val === "yes") out.push("Fast");
      continue;
    }
    if (modelParamFamily(key) === "context" && val) {
      out.push(val.toUpperCase());
      continue;
    }
    if (modelParamFamily(key) === "effort" && val) {
      const effortMap: Record<string, string> = {
        none: "None",
        low: "Low",

        medium: "Medium",
        high: "High",
        "extra-high": "Extra High",
        xhigh: "Extra High",
        max: "Max",
      };
      out.push(effortMap[val] ?? capitalizeToken(val));
      continue;
    }
    if (val === "true" || val === "1") {
      out.push(capitalizeToken(key));
      continue;
    }
    if (!val || val === "false" || val === "0") continue;
    out.push(`${capitalizeToken(key)} ${val}`);
  }
  return out;
}

function humanizeModelBase(base: string): string {
  const tail = base.includes("/") ? base.split("/").pop()! : base;
  // Keep version-like tokens with dots intact: grok-4.5 → Grok 4.5
  return tail
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => {
      if (/^\d+(\.\d+)*$/.test(token)) return token;
      if (/^\d+m$/i.test(token)) return token.toUpperCase();
      const known: Record<string, string> = {
        gpt: "GPT",
        claude: "Claude",
        opus: "Opus",
        sonnet: "Sonnet",
        haiku: "Haiku",
        codex: "Codex",
        composer: "Composer",
        cursor: "Cursor",
        grok: "Grok",
        sol: "Sol",
        terra: "Terra",
        kimi: "Kimi",
        xhigh: "Extra High",
        fast: "Fast",
        high: "High",
        medium: "Medium",
        none: "None",
      };
      return known[token.toLowerCase()] ?? capitalizeToken(token);
    })
    .join(" ");
}

function capitalizeToken(token: string): string {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export interface ChatThemeDto {
  id: string;
  name: string;
  /** Legacy unused column; folder cwd lives on sessions. */
  path: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SlashCommandDto {
  name: string;
  description: string;
  /** Agent command expects text after the command name. */
  requiresInput?: boolean;
  inputHint?: string;
  /** ACP/harness tag when present (`skill`, …). */
  kind?: string;
  /** From the user's `.cursor/commands` or `.cursor/skills` on disk. */
  local?: boolean;
}

/** Later lists win on the same name; empty lists are ignored so a stale GET cannot shrink the menu. */
export function mergeSlashCommandLists(
  ...lists: Array<SlashCommandDto[] | undefined>
): SlashCommandDto[] {
  const byName = new Map<string, SlashCommandDto>();
  for (const list of lists) {
    if (!list?.length) continue;
    for (const cmd of list) {
      const name = cmd.name.trim().replace(/^\//, "");
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key);
      const next: SlashCommandDto = { ...cmd, name };
      if (prev?.local || cmd.local) next.local = true;
      if (prev?.kind === "skill" || cmd.kind === "skill") next.kind = "skill";
      byName.set(key, next);
    }
  }
  return [...byName.values()];
}

/** Token/context usage reported by the harness via ACP `usage_update`. */
export interface AcpUsage {
  /** Model context window size in tokens (if the harness reports it). */
  contextWindow?: number;
  /** Tokens currently/estimated used in the context window. */
  usedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Input tokens served from the provider's prompt cache. They are still part
   * of `inputTokens`; this is the cheap subset, reported separately because it
   * is what actually costs time (and often money).
   */
  cachedInputTokens?: number;
  /** Cumulative cost (currency units) if the harness reports it. */
  cost?: number;
  /** Original harness payload, kept for fields we don't normalize. */
  raw?: Record<string, unknown>;
}

export interface SessionDto {
  id: string;
  title: string;
  provider: AgentProvider;
  cwd: string;
  mode: AgentMode;
  status: SessionStatus;
  acpSessionId: string | null;
  themeId: string | null;
  sortOrder: number;
  /** Pinned sessions float to the top of the sidebar. */
  pinned: boolean;
  /** Archived sessions are hidden from the main tree (Архив section). */
  archived: boolean;
  /** Board partition: null = regular chat; a value = task on that board.
   *  Board tasks never show in the chat tree or global search. */
  boardId: string | null;
  /** Task description written at creation: card text and the prefill for the
   *  first message. Null for regular chats. */
  taskDescription: string | null;
  /** Server-set when the board task's first turn starts (Todo ⇄ Wait split). */
  startedAt: string | null;
  /** Set while the user considers the task finished (Wait ⇄ Done). Board Done
   *  lanes read newest-first off this, so `sortOrder` is a Todo-lane thing. */
  doneAt: string | null;
  /** MCP server ids disabled for THIS chat only (global list still applies to others). */
  mcpDisabledIds: string[];
  /** Token/context usage reported by the harness via ACP (null until/if reported). */
  usage?: AcpUsage | null;
  /** Model pinned to this chat: resolved from settings when the chat is
   *  created, then changed only by an explicit pick inside the chat.
   *  Empty/null → settings default for the harness (legacy rows). */
  model?: string | null;
  /** Parameter picker values for this chat's model (pinned with the model). */
  modelParams?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the latest message in the session (falls back to createdAt). */
  lastMessageAt: string;
}

export interface GitChangedFileDto {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
}

export interface GitStatusDto {
  repo: boolean;
  root: string;
  branch: string;
  dirty: boolean;
  conflict: boolean;
  branches: string[];
  files: GitChangedFileDto[];
  stagedCount: number;
  unstagedCount: number;
  additions: number;
  deletions: number;
  stashCount: number;
  /** Commits on HEAD not in the upstream (unpushed). */
  aheadCount: number;
  /** Commits on the upstream not in HEAD (unpulled). */
  behindCount: number;
  /**
   * Local branches the app will not delete: the checked-out one and the
   * repository's main one. The delete button is hidden for these, and the
   * delete route refuses them independently.
   */
  protectedBranches: string[];
}

export interface GitCommitDto {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  /**
   * Graph line the row is drawn on: 0 = a tip, deeper = a side line of a merge.
   * Assigned where the list is drawn — the history list walks the commits it has
   * loaded, so the graph stays continuous as older pages arrive.
   */
  depth?: number;
  merge: boolean;
  /** Branch and remote ref tips pointing at this commit. */
  refs: string[];
}

/**
 * One page of git history: the commits themselves, the local commits of the
 * checked-out branch, and the branches the history filter can pick from.
 */
export interface GitLogPageDto {
  commits: GitCommitDto[];
  /** Upstream..HEAD commits; only the first page carries them. */
  outgoing?: GitCommitDto[];
  /** Another page follows — the list asks for it when the reader scrolls. */
  hasMore: boolean;
  /** Local branch names first, then remote ones, each group alphabetical. */
  branches: string[];
}

export type GitCommitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "other";

export interface GitCommitFileDto {
  path: string;
  oldPath?: string;
  status: GitCommitFileStatus;
  additions: number;
  deletions: number;
}

export interface GitCommitDetailDto {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
  parents: string[];
  parentShortHashes: string[];
  files: GitCommitFileDto[];
  additions: number;
  deletions: number;
  modifiedCount: number;
  addedCount: number;
  deletedCount: number;
}

export interface MessagePartDto {
  id: string;
  messageId: string;
  type: MessagePartType;
  order: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  parts: MessagePartDto[];
}

export interface SessionDetailDto extends SessionDto {
  messages: MessageDto[];
  slashCommands?: SlashCommandDto[];
}

export type WsServerEvent =
  | { type: "session.updated"; sessionId: string; session: SessionDto }
  | { type: "session.usage"; sessionId: string; usage: AcpUsage }
  | { type: "message.created"; sessionId: string; message: MessageDto }
  | {
      type: "part.appended";
      sessionId: string;
      messageId: string;
      part: MessagePartDto;
    }
  | {
      type: "part.updated";
      sessionId: string;
      messageId: string;
      part: MessagePartDto;
    }
  | {
      type: "permission.request";
      sessionId: string;
      requestId: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "question.request";
      sessionId: string;
      requestId: string;
      kind: "ask_question" | "create_plan" | "switch_mode";
      payload: Record<string, unknown>;
    }
  | {
      type: "commands.updated";
      sessionId: string;
      commands: SlashCommandDto[];
    }
  | {
      type: "agent.availability";
      provider: AgentProvider;
      available: boolean;
    }
  | {
      type: "messages.truncated";
      sessionId: string;
      messages: MessageDto[];
    }
  | {
      type: "messages.replaced";
      sessionId: string;
      messages: MessageDto[];
    }
  | { type: "error"; sessionId?: string; message: string }
  | { type: "process.output"; sessionId: string; text: string; source?: "agent" | "shell" }
  | { type: "process.cleared"; sessionId: string }
  | { type: "pong" };

export type WsClientEvent =
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "process.input"; sessionId: string; data: string }
  | { type: "process.resize"; sessionId: string; cols: number; rows: number }
  | { type: "process.clear"; sessionId: string };

export interface ModelParamDto {
  id: string;
  name: string;
  currentValue?: string;
  options: Array<{ value: string; name: string }>;
}

/** Agent-side session that is not (yet) a row in the Acpio tree. */
export interface HarnessSessionDto {
  provider: AgentProvider;
  acpSessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

export interface AgentProbeResult {
  ok: boolean;
  provider: AgentProvider;
  command: string;
  message: string;
  details?: string;
  sessionId?: string;
  currentModel?: string;
  models?: ModelOption[];
  modelParams?: ModelParamDto[];
  modes?: Array<{ value: string; name: string }>;
}

export interface DiagnosticsDumpMeta {
  id: string;
  fileName: string;
  reason: string;
  createdAt: string;
  size: number;
  path: string;
}

export interface DiagnosticsDumpDto extends DiagnosticsDumpMeta {
  payload: Record<string, unknown>;
}

/** Parse `base[k=v,k2=v2]` into base + params. */
export function parseModelWire(wire: string): { base: string; params: Record<string, string> } {
  const raw = (wire || "").trim();
  const match = raw.match(/^([^[\]]+?)\s*\[([^\]]*)\]\s*$/);
  if (!match) return { base: raw, params: {} };
  const params: Record<string, string> = {};
  for (const piece of (match[2] ?? "").split(",")) {
    const [k, ...rest] = piece.split("=");
    const key = (k ?? "").trim();
    if (!key) continue;
    params[key] = rest.join("=").trim();
  }
  return { base: (match[1] ?? "").trim(), params };
}

export function modelParamLabel(
  paramId: string,
  value: string,
  name?: string,
  labels?: { yes?: string; no?: string },
): string {
  const family = modelParamFamily(paramId) ?? inferParamFamily(paramId, name);
  const v = value.toLowerCase();
  if (family === "fast") {
    if (v === "true" || v === "1" || v === "yes") return "Fast";
    if (v === "false" || v === "0" || v === "no") return "Not Fast";
  }
  if (family === "effort") {
    const map: Record<string, string> = {
      none: "None",
      off: "None",
      low: "Low",
      medium: "Medium",
      med: "Medium",
      high: "High",
      "extra-high": "Extra High",
      xhigh: "Extra High",
      extra_high: "Extra High",
      extrahigh: "Extra High",
      max: "Max",
      minimal: "Minimal",
      default: "Default",
    };
    if (map[v]) return map[v];
    const fromName = (name ?? "").trim().toLowerCase();
    if (fromName && map[fromName]) return map[fromName];
    return capitalizeToken(value);
  }
  if (name && name.trim() && name.trim() !== value) return name.trim();
  if (v === "true") return labels?.yes ?? "Yes";
  if (v === "false") return labels?.no ?? "No";
  return value;
}

function inferParamFamily(paramId: string, name?: string): ModelParamFamily | null {
  const blob = `${paramId} ${name ?? ""}`.toLowerCase();
  if (/\bfast\b/.test(blob)) return "fast";
  if (/effort|reason|thought|thinking/.test(blob)) return "effort";
  if (/\bcontext\b/.test(blob)) return "context";
  return null;
}

/** Prefer stable section titles for Cursor aliases (reasoning → Effort). */
export function modelParamSectionName(paramId: string, name?: string): string {
  const family = modelParamFamily(paramId) ?? inferParamFamily(paramId, name);
  if (family === "fast") return "Fast";
  if (family === "effort") return "Effort";
  if (family === "context") return name?.trim() || "Context";
  if (name && name.trim()) {
    const n = name.trim();
    if (/^fast$/i.test(n)) return "Fast";
    return n;
  }
  return paramId;
}

/** ACP tool `kind` values that denote a nested agent (subagent) invocation. */
const SUBAGENT_TOOL_KINDS = new Set([
  "task",
  "subagent",
  "explore",
  "browser",
  "generalPurpose",
  "ci-investigator",
  "bugbot",
  "security-review",
  "best-of-n",
]);

/**
 * Decide whether an ACP tool call runs a nested agent. Only the structured
 * `kind` field is consulted — never the free-text title. Kinds are per-agent:
 * Cursor reports its documented subagent tool kinds; agents that omit `kind`
 * (e.g. OMP) render as plain tool calls.
 */
export function isSubagentToolCall(kind: string): boolean {
  return SUBAGENT_TOOL_KINDS.has(kind.trim().toLowerCase());
}

/**
 * Titles that carry no tool identity: placeholders the agent emits when the
 * real name is unavailable ("Tool", "task") or a generic MCP label ("MCP: tool").
 * When the title is one of these the real tool name (`toolName`) must be shown
 * instead — see `toolDisplayTitle`.
 */
export function isGenericToolTitle(title: string): boolean {
  const value = title.trim();
  if (!value) return true;
  return /^(tool|task|subagent|агент|субагент|mcp\s*[:：]?\s*tool)$/i.test(value);
}

/** First meaningful subject from a tool call's args (Cursor sends no tool name). */
function subjectFromToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const row = args as Record<string, unknown>;
  for (const key of ["query", "path", "command", "pattern", "text", "url", "searchText", "q"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Best display name for a tool call: a meaningful agent-provided title wins;
 * otherwise fall back to the real tool name (which for MCP tools comes as
 * `mcp__<server>_<tool>` and loses its transport prefix), then to the call's
 * own subject (query/path/… — Cursor never sends the tool name for MCP tools).
 * Empty string when nothing carries a name — callers use their own "Tool" label.
 */
export function toolDisplayTitle(title: string, toolName?: string, args?: unknown): string {
  if (!isGenericToolTitle(title)) return title.trim();
  const name = (toolName ?? "").trim();
  if (name && !isGenericToolTitle(name)) {
    return name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  }
  const subject = subjectFromToolArgs(args);
  if (subject) return subject;
  return "";
}

