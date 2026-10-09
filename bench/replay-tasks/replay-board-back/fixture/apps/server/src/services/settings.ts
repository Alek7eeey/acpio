import { eq } from "drizzle-orm";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  McpServerConfig,
  SETTINGS_SCHEMA_VERSION,
  mergeChatChipOptions,
  normalizeChatChipOptions,
  normalizeChatMetaChips,
  normalizeChatTreeRecentLimit,
  normalizeCustomAgents,
  canonicalCwd,
  normalizeMcpProjectFiles,
  readSettingsSchema,
} from "@acpio/shared";
import { db, REPO_ROOT } from "../db/client.js";
import { settings } from "../db/schema.js";
import { adapters, RESERVED_AGENT_IDS, setCustomAdapters } from "../adapters/registry.js";
import { generateRemoteAccessKey } from "../lib/remoteAccess.js";
import { syncDeepLoggingFromSettings } from "./deepLogging.js";

const SETTINGS_KEY = "app";
/** Total persisted composer-draft payload cap (keys + text), in characters. */
const COMPOSER_DRAFTS_MAX_BYTES = 200_000;

/** True when the provider is a registered harness adapter. */
function isKnownProvider(provider: unknown): provider is string {
  return typeof provider === "string" && adapters.ids().includes(provider);
}

/** Keep only valid config ids, healing rows saved before an id was removed.
 *  An empty result is valid (the user may disable every item). */
function filterValid<T extends string>(values: unknown[], valid: T[]): T[] {
  return values.filter((v): v is T => typeof v === "string" && valid.includes(v as T));
}

/** Drop malformed rows and upgrade pre-stdio rows stored as `local` + command. */
function healMcpServerList(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        (s.type === "local" || s.type === "remote" || s.type === "stdio"),
    )
    .map((s) => {
      // Pre-stdio UI stored local processes as type "local" + command, no URL.
      if (
        s.type === "local" &&
        typeof s.command === "string" &&
        s.command.trim() &&
        !(typeof s.url === "string" && s.url.trim())
      ) {
        return { ...s, type: "stdio" as const };
      }
      return s;
    });
}

/** Per-folder switches kept for one folder (a folder has far fewer servers). */
const MCP_FOLDER_OVERRIDES_MAX = 200;

/**
 * Folder MCP switches: boolean rows only. Rows saved before the tri-state
 * switch stored a plain `disabledIds` list — those become explicit `false`
 * entries, which is exactly what they meant.
 */
function healMcpFolderOverrides(cfg: {
  overrides?: unknown;
  disabledIds?: unknown;
}): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const rawOverrides =
    cfg.overrides && typeof cfg.overrides === "object" && !Array.isArray(cfg.overrides)
      ? Object.entries(cfg.overrides as Record<string, unknown>)
      : [];
  const rawIds = Array.isArray(cfg.disabledIds) ? cfg.disabledIds : [];
  for (const [rawId, rawOn] of rawOverrides) {
    const id = rawId.trim();
    if (!id || typeof rawOn !== "boolean") continue;
    if (Object.keys(out).length >= MCP_FOLDER_OVERRIDES_MAX) break;
    out[id] = rawOn;
  }
  for (const rawId of rawIds) {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!id) continue;
    if (Object.keys(out).length >= MCP_FOLDER_OVERRIDES_MAX) break;
    // A legacy disabled id never overrides an explicit switch already read.
    out[id] ??= false;
  }
  return out;
}

function mergeSettings(raw: unknown): AppSettings {
  const base = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return base;
  const merged = { ...base, ...(raw as Partial<AppSettings>) };
  // Drop fields of harnesses removed from the app (OpenCode / PI).
  for (const stale of [
    "opencodeCommand",
    "opencodeArgs",
    "opencodeApiKey",
    "piCommand",
    "piArgs",
  ] as const) {
    delete (merged as Record<string, unknown>)[stale];
  }
  // User-defined agents must be in the registry before the provider fields
  // below are validated — otherwise a freshly added agent is healed away.
  merged.customAgents = normalizeCustomAgents(merged.customAgents, RESERVED_AGENT_IDS);
  setCustomAdapters(merged.customAgents);
  // Backward-compatible defaults for newly added fields
  if (!merged.ompCommand) merged.ompCommand = DEFAULT_SETTINGS.ompCommand;
  if (!Array.isArray(merged.ompArgs)) {
    merged.ompArgs = [...DEFAULT_SETTINGS.ompArgs];
  }
  if (!isKnownProvider(merged.defaultProvider)) {
    merged.defaultProvider = DEFAULT_SETTINGS.defaultProvider;
  }
  if (merged.locale !== "en" && merged.locale !== "ru") {
    merged.locale = DEFAULT_SETTINGS.locale;
  }
  if (typeof merged.displayName !== "string") {
    merged.displayName = DEFAULT_SETTINGS.displayName;
  }
  if (merged.connectedProvider !== null && !isKnownProvider(merged.connectedProvider)) {
    merged.connectedProvider = DEFAULT_SETTINGS.connectedProvider;
  }
  merged.disabledProviders = Array.isArray(merged.disabledProviders)
    ? filterValid(merged.disabledProviders, adapters.ids())
    : [];
  // A disabled harness can be neither the default nor the connected agent.
  const enabledIds = adapters.ids().filter((id) => !merged.disabledProviders.includes(id));
  if (merged.disabledProviders.includes(merged.defaultProvider)) {
    merged.defaultProvider = enabledIds[0] ?? DEFAULT_SETTINGS.defaultProvider;
  }
  if (merged.connectedProvider && merged.disabledProviders.includes(merged.connectedProvider)) {
    merged.connectedProvider = null;
  }
  if (typeof merged.diagnosticsDir !== "string") {
    merged.diagnosticsDir = DEFAULT_SETTINGS.diagnosticsDir;
  }
  if (typeof merged.diagnosticsDeepLogging !== "boolean") {
    merged.diagnosticsDeepLogging = DEFAULT_SETTINGS.diagnosticsDeepLogging;
  }
  if (typeof merged.exportDir !== "string") {
    merged.exportDir = DEFAULT_SETTINGS.exportDir;
  }
  if (typeof merged.resumeAgentContext !== "boolean") {
    merged.resumeAgentContext = DEFAULT_SETTINGS.resumeAgentContext;
  }
  if (typeof merged.showBootSplash !== "boolean") {
    merged.showBootSplash = DEFAULT_SETTINGS.showBootSplash;
  }
  for (const key of ["fontFamily", "fontSize", "lightScheme", "darkScheme"] as const) {
    if (typeof merged[key] !== "string") {
      merged[key] = "";
    }
  }
  for (const key of [
    "lightAccent",
    "lightBg",
    "lightSurface",
    "darkAccent",
    "darkBg",
    "darkSurface",
  ] as const) {
    if (typeof merged[key] !== "string") {
      merged[key] = "";
    }
  }
  if (merged.ttsVoiceGender !== "female" && merged.ttsVoiceGender !== "male") {
    merged.ttsVoiceGender = "";
  }
  if (!Array.isArray(merged.chatActions)) {
    merged.chatActions = [...DEFAULT_SETTINGS.chatActions];
  } else {
    merged.chatActions = filterValid(merged.chatActions, [
      "copy",
      "edit",
      "like",
      "dislike",
      "share",
      "regenerate",
      "readAloud",
    ]);
  }
  if (!Array.isArray(merged.chatMetaChips)) {
    merged.chatMetaChips = [...DEFAULT_SETTINGS.chatMetaChips];
  } else {
    merged.chatMetaChips = normalizeChatMetaChips(
      merged.chatMetaChips,
      readSettingsSchema(raw),
    );
  }
  merged.settingsSchema = SETTINGS_SCHEMA_VERSION;
  if (merged.thoughtsChipStyle !== "icon") {
    merged.thoughtsChipStyle = "full";
  }
  if (merged.consoleChipStyle !== "icon") {
    merged.consoleChipStyle = "full";
  }
  if (merged.terminalShell !== "powershell") {
    merged.terminalShell = "cmd";
  }
  if (!Array.isArray(merged.chatComposerButtons)) {
    merged.chatComposerButtons = [...DEFAULT_SETTINGS.chatComposerButtons];
  } else {
    merged.chatComposerButtons = filterValid(merged.chatComposerButtons, [
      "attach",
      "mic",
      "model",
      "mode",
    ]);
  }
  if (!Array.isArray(merged.chatTreeElements)) {
    merged.chatTreeElements = [...DEFAULT_SETTINGS.chatTreeElements];
  } else {
    merged.chatTreeElements = filterValid(merged.chatTreeElements, [
      "search",
      "searchMsgs",
      "pin",
      "archive",
      "more",
    ]);
  }
  if (!Array.isArray(merged.chatTreeMenu)) {
    merged.chatTreeMenu = [...DEFAULT_SETTINGS.chatTreeMenu];
  } else {
    merged.chatTreeMenu = filterValid(merged.chatTreeMenu, ["rename", "move", "export", "delete"]);
  }
  if (typeof merged.chatTreeShowArchive !== "boolean") {
    merged.chatTreeShowArchive = DEFAULT_SETTINGS.chatTreeShowArchive;
  }
  merged.chatTreeRecentLimit = normalizeChatTreeRecentLimit(merged.chatTreeRecentLimit);
  if (
    typeof merged.chatHeaderHeight !== "number" ||
    !Number.isFinite(merged.chatHeaderHeight)
  ) {
    merged.chatHeaderHeight = DEFAULT_SETTINGS.chatHeaderHeight;
  } else {
    merged.chatHeaderHeight = Math.min(72, Math.max(40, Math.round(merged.chatHeaderHeight)));
  }
  if (!Array.isArray(merged.chatHeaderIcons)) {
    merged.chatHeaderIcons = [...DEFAULT_SETTINGS.chatHeaderIcons];
  } else {
    merged.chatHeaderIcons = filterValid(merged.chatHeaderIcons, ["lang", "install", "theme"]);
  }
  if (typeof merged.chatEnterToSend !== "boolean") {
    merged.chatEnterToSend = DEFAULT_SETTINGS.chatEnterToSend;
  }
  if (typeof merged.chatShowMessageTime !== "boolean") {
    merged.chatShowMessageTime = DEFAULT_SETTINGS.chatShowMessageTime;
  }
  if (typeof merged.chatAgentTurnTimeline !== "boolean") {
    merged.chatAgentTurnTimeline = DEFAULT_SETTINGS.chatAgentTurnTimeline;
  }
  if (merged.chatGitBranchPosition !== "above") {
    merged.chatGitBranchPosition = "below";
  }
  merged.chatChipOptions = normalizeChatChipOptions(merged.chatChipOptions);
  if (typeof merged.chatSplit !== "boolean") {
    merged.chatSplit = DEFAULT_SETTINGS.chatSplit;
  }
  merged.chatToolbarStyle =
    merged.chatToolbarStyle === "minimal" ? "minimal" : DEFAULT_SETTINGS.chatToolbarStyle;
  if (merged.attachDefaultSource !== "server") {
    merged.attachDefaultSource = "device";
  }
  if (typeof merged.remoteAccessKey !== "string") {
    merged.remoteAccessKey = "";
  }
  if (
    !merged.defaultModelByProvider ||
    typeof merged.defaultModelByProvider !== "object" ||
    Array.isArray(merged.defaultModelByProvider)
  ) {
    merged.defaultModelByProvider = {};
  }
  if (
    !merged.defaultModelParamsByProvider ||
    typeof merged.defaultModelParamsByProvider !== "object" ||
    Array.isArray(merged.defaultModelParamsByProvider)
  ) {
    merged.defaultModelParamsByProvider = {};
  }
  for (const key of [
    "modelParamsByProviderModel",
    "recentModelsByProvider",
    "favoriteModelsByProvider",
  ] as const) {
    if (!merged[key] || typeof merged[key] !== "object" || Array.isArray(merged[key])) {
      merged[key] = {};
    }
  }
  if (
    merged.defaultProvider &&
    merged.defaultModel &&
    !merged.defaultModelByProvider[merged.defaultProvider]
  ) {
    merged.defaultModelByProvider = {
      ...merged.defaultModelByProvider,
      [merged.defaultProvider]: merged.defaultModel,
    };
  }
  // Fields replaced by icon-level controls / never shipped.
  for (const stale of [
    "chatReadAloud",
    "chatVoiceInput",
    "chatTreeDensity",
    "chatHeaderSize",
    "chatToolbarSize",
    "chatTreeCompact",
    "chatComposerHeight",
  ] as const) {
    delete (merged as Record<string, unknown>)[stale];
  }
  merged.mcpServers = healMcpServerList(merged.mcpServers);
  // Per-folder switches: canonical cwd keys, validated servers, boolean rows.
  // A folder with nothing left to say is dropped so the map stays sparse and a
  // later global change is inherited instead of being blocked by a stale entry.
  {
    const rawFolders = merged.mcpFolderConfigs;
    const folders: AppSettings["mcpFolderConfigs"] = {};
    if (rawFolders && typeof rawFolders === "object" && !Array.isArray(rawFolders)) {
      for (const [rawCwd, value] of Object.entries(rawFolders as Record<string, unknown>)) {
        const key = canonicalCwd(rawCwd);
        if (!key) continue;
        const cfg = (value ?? {}) as {
          overrides?: unknown;
          disabledIds?: unknown;
          servers?: unknown;
        };
        const servers = healMcpServerList(cfg.servers);
        const overrides = healMcpFolderOverrides(cfg);
        if (!servers.length && !Object.keys(overrides).length) continue;
        folders[key] = { overrides, servers };
      }
    }
    merged.mcpFolderConfigs = folders;
  }
  // Folder MCP files: relative paths inside the chat's own cwd only.
  merged.mcpProjectFiles = normalizeMcpProjectFiles(merged.mcpProjectFiles);
  // Composer drafts persist so typed text survives a reload. Heal the map:
  // only string keys with non-empty trimmed string values survive, and the
  // whole blob is capped so it cannot grow without bound.
  {
    const rawDrafts = merged.composerDrafts;
    const drafts: Record<string, string> = {};
    let bytes = 0;
    if (rawDrafts && typeof rawDrafts === "object" && !Array.isArray(rawDrafts)) {
      for (const [key, value] of Object.entries(rawDrafts as Record<string, unknown>)) {
        if (!key.trim()) continue;
        // Ephemeral pre-chat pane tokens are never persisted.
        if (key.startsWith("pane:")) continue;
        if (typeof value !== "string") continue;
        const text = value.trim() ? value : "";
        if (!text) continue;
        const cost = key.length + text.length;
        if (bytes + cost > COMPOSER_DRAFTS_MAX_BYTES) break;
        drafts[key] = text;
        bytes += cost;
      }
    }
    merged.composerDrafts = drafts;
  }
  return merged;
}

async function persistSettings(next: AppSettings): Promise<void> {
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: new Date() },
    });
  syncDeepLoggingFromSettings(next);
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (!rows[0]) {
    const seeded = mergeSettings({
      defaultCwd: process.env.DEFAULT_CWD || REPO_ROOT,
      cursorApiKey: process.env.CURSOR_API_KEY ?? "",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      remoteAccessKey: generateRemoteAccessKey(),
    });
    await persistSettings(seeded);
    return seeded;
  }
  const raw = rows[0].value;
  const merged = mergeSettings(raw);
  const schema = readSettingsSchema(raw);
  // Schema < 4: empty key was the old default, not an explicit opt-out — fill one.
  if (!merged.remoteAccessKey.trim() && schema < 4) {
    merged.remoteAccessKey = generateRemoteAccessKey();
    merged.settingsSchema = SETTINGS_SCHEMA_VERSION;
    await persistSettings(merged);
    return merged;
  }
  syncDeepLoggingFromSettings(merged);
  return merged;
}

/** Drop a folder's MCP override (the folder and its chats are gone). */
export async function forgetMcpFolderConfig(cwd: string): Promise<void> {
  const key = canonicalCwd(cwd);
  if (!key) return;
  const current = await getSettings();
  if (!current.mcpFolderConfigs[key]) return;
  const next = { ...current.mcpFolderConfigs };
  delete next[key];
  await updateSettings({ mcpFolderConfigs: next });
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    // A patch may carry a single chip (the form saves one row at a time) —
    // deep-merge so the other chips keep their options.
    chatChipOptions: patch.chatChipOptions
      ? mergeChatChipOptions(current.chatChipOptions, patch.chatChipOptions)
      : current.chatChipOptions,
    settingsSchema: SETTINGS_SCHEMA_VERSION,
  });
  await persistSettings(next);
  return next;
}
