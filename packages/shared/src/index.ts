import type {
  AgentMode,
  AgentModeOption,
  AgentProvider,
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
  HarnessAdapter,
  ModelOption,
  SubagentCardUpdate,
  SubagentProgressUpdate,
  SubagentTranscriptPage,
} from "./adapters.js";

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
    if (obj.content !== undefined) return textFromUnknown(obj.content);
    if (obj.result !== undefined) return textFromUnknown(obj.result);
  }
  return "";
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
  const prompt =
    textFromUnknown(raw.prompt) ||
    textFromUnknown((raw.rawInput as Record<string, unknown> | undefined)?.prompt) ||
    textFromUnknown((raw.arguments as Record<string, unknown> | undefined)?.prompt) ||
    textFromUnknown((raw.input as Record<string, unknown> | undefined)?.prompt);
  const result = textFromUnknown(raw.result) || textFromUnknown(raw.content);
  const titled = String(raw.title ?? raw.description ?? raw.name ?? raw.label ?? "").trim();
  const fromBody =
    result.match(/^###\s+([^\n\[]+?)(?:\s*\[|$)/m)?.[1]?.trim() ||
    result.match(/^\s*Label:\s*(.+)$/m)?.[1]?.trim() ||
    result.match(/<task-result\b[^>]*\bid="([^"]+)"/i)?.[1]?.trim() ||
    "";
  const niceTitle = [titled, fromBody].find((v) => v && !/^(tool|task|subagent|субагент)$/i.test(v));
  return {
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(niceTitle ? { title: niceTitle, description: niceTitle } : {}),
  };
}

/** MCP server connection defined in Settings → Connections. */
export type McpServerConfig = {
  /** Stable unique id. */
  id: string;
  name: string;
  enabled: boolean;
  /** "local" — same-network HTTP endpoint (URL only); "remote" — external endpoint with token. */
  type: "local" | "remote";
  /** Endpoint URL (both types). */
  url?: string;
  /** Bearer token for remote servers (never displayed in full). */
  token?: string;
  /** @deprecated Local stdio servers are no longer configured in the UI. */
  command?: string;
  args?: string[];
};

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
export type ChatMetaChipId = "folder" | "thoughts" | "mcp";

/** Optional controls in the chat tree. Core actions (new chat, folder add)
 *  are always visible and cannot be hidden. */
export type ChatTreeElementId = "search" | "searchMsgs" | "pin" | "archive" | "more";

/** Optional buttons in the composer bar. The input and send button are
 *  always visible. */
export type ChatComposerButtonId = "attach" | "mic" | "model" | "mode";

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

export interface AppSettings {
  theme: Theme;
  locale: AppLocale;
  /** Local display name shown in the header. */
  displayName: string;
  /** Agent explicitly connected in Settings → Connect. */
  connectedProvider: AgentProvider | null;
  defaultProvider: AgentProvider;
  defaultMode: AgentMode;
  defaultCwd: string;
  defaultModel: string;
  /** Cursor ACP parameterized picker values (fast, effort, context, …). */
  defaultModelParams: Record<string, string>;
  cursorCommand: string;
  cursorArgs: string[];
  ompCommand: string;
  ompArgs: string[];
  cursorApiKey: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  permissionPolicy: PermissionPolicy;
  permissionAllowlist: string[];
  /** Folder on the server where diagnostic dumps are written. Empty → default under repo. */
  diagnosticsDir: string;
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
  /** Preferred read-aloud voice gender ("" = browser default). */
  ttsVoiceGender: "" | "female" | "male";
  /**
   * Message action buttons under each message, in display order. The first 5
   * enabled actions render as icons, the rest hide behind the "⋯" menu.
   */
  chatActions: ChatActionId[];
  /** Chips shown in the composer bar above the input. */
  chatMetaChips: ChatMetaChipId[];
  /** Optional composer buttons (attach, mic, model, mode picker). */
  chatComposerButtons: ChatComposerButtonId[];
  /** Tree sidebar controls shown (search, per-row actions). */
  chatTreeElements: ChatTreeElementId[];
  /** Compact rows in the chat tree. */
  chatTreeCompact: boolean;
  /** Show the "Archive" section in the chat tree. */
  chatTreeShowArchive: boolean;
  /** App header height in px (drag the header in the preview). */
  chatHeaderHeight: number;
  /** Composer input height in px (drag the composer in the preview). */
  chatComposerHeight: number;
  /** Enter sends the message; off → Enter inserts a newline, Ctrl+Enter sends. */
  chatEnterToSend: boolean;
  /** Show the send time next to each message. */
  chatShowMessageTime: boolean;
  /** MCP servers attached to the agent (local stdio + remote endpoints). */
  mcpServers: McpServerConfig[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  locale: "ru",
  displayName: "",
  connectedProvider: null,
  defaultProvider: "cursor",
  defaultMode: "agent",
  defaultCwd: "",
  defaultModel: "",
  defaultModelParams: {},
  cursorCommand: "agent",
  cursorArgs: ["acp"],
  ompCommand: "omp",
  ompArgs: ["acp"],
  cursorApiKey: "",
  anthropicApiKey: "",
  openaiApiKey: "",
  permissionPolicy: "always",
  permissionAllowlist: [],
  diagnosticsDir: "",
  exportDir: "",
  resumeAgentContext: true,
  multitask: false,
  sidebarCollapse: "full",
  showBootSplash: true,
  fontFamily: "",
  fontSize: "",
  lightScheme: "",
  darkScheme: "",
  ttsVoiceGender: "",
  chatActions: ["copy", "edit", "like", "dislike", "share", "regenerate", "readAloud"],
  chatMetaChips: ["folder", "thoughts", "mcp"],
  chatComposerButtons: ["attach", "mic", "model", "mode"],
  chatTreeElements: ["search", "searchMsgs", "pin", "archive", "more"],
  chatTreeCompact: false,
  chatTreeShowArchive: true,
  chatHeaderHeight: 52,
  chatComposerHeight: 40,
  chatEnterToSend: true,
  chatShowMessageTime: false,
  mcpServers: [],
};

/** Billing / credits failure from OMP when a model cannot be used. */
export function isModelAccessError(message: string): boolean {
  return /Insufficient balance|CreditsError|insufficient.?credits|payment required|billing/i.test(
    message,
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
  // Prefer a clean agent-provided title (e.g. "Cursor Grok 4.5 Fast").
  if (provided && !hasModelParams(provided) && !isRawWireSlug(provided)) {
    if (/^default(\[.*\])?$/i.test(provided) || /^auto$/i.test(provided)) return defaultLabel;
    return provided;
  }

  return prettifyModelWireId(raw || provided, defaultLabel);
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
        low: "Low",
        max: "Max",
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
  /** MCP server ids disabled for THIS chat only (global list still applies to others). */
  mcpDisabledIds: string[];
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the latest message in the session (falls back to createdAt). */
  lastMessageAt: string;
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
      kind: "ask_question" | "create_plan";
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
  | { type: "pong" };

export type WsClientEvent =
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string };

export interface ModelParamDto {
  id: string;
  name: string;
  currentValue?: string;
  options: Array<{ value: string; name: string }>;
}

export interface AgentProbeResult {
  ok: boolean;
  provider: AgentProvider;
  command: string;
  message: string;
  details?: string;
  sessionId?: string;
  currentModel?: string;
  models?: Array<{ value: string; name: string }>;
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

