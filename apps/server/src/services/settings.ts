import { eq } from "drizzle-orm";
import {
  AppSettings,
  BuiltinProviderConfig,
  ComposerDraft,
  ComposerDraftFile,
  DEFAULT_SETTINGS,
  McpServerConfig,
  PluginEntryConfig,
  PluginProviderOverride,
  PluginSkillFolder,
  normalizeBuiltinModelRows,
  SETTINGS_SCHEMA_VERSION,
  mergeChatChipOptions,
  normalizeBuiltinMaxOutputTokens,
  normalizeBuiltinTurnRetryAttempts,
  normalizeBuiltinThinkingLimit,
  normalizeBuiltinContextSettings,
  normalizeBuiltinExtraInstructions,
  normalizeBuiltinProviders,
  normalizeBuiltinPresets,
  normalizeBuiltinSubagents,
  normalizeChatChipOptions,
  normalizeChatMetaChips,
  normalizeChatTitleMaxLen,
  normalizeChatTreeRecentLimit,
  normalizeCustomAgents,
  canonicalCwd,
  normalizeMcpProjectFiles,
  normalizeSkillModes,
  normalizeSkillPaths,
  readSettingsSchema,
} from "@acpio/shared";
import { db, REPO_ROOT } from "../db/client.js";
import { settings } from "../db/schema.js";
import {
  adapters,
  presetProviderIds,
  RESERVED_AGENT_IDS,
  setCustomAdapters,
} from "../adapters/registry.js";
import { generateRemoteAccessKey } from "../lib/remoteAccess.js";
import { syncDeepLoggingFromSettings } from "./deepLogging.js";

const SETTINGS_KEY = "app";
/** Total persisted composer-draft payload cap (keys + text + files), in characters. */
const COMPOSER_DRAFTS_MAX_BYTES = 200_000;
/** Files one draft may name — the composer stages no more than this either. */
const COMPOSER_DRAFT_FILES_MAX = 50;

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
  // Drop fields of harnesses removed from the app (PI) or never shipped
  // (OpenCode keeps its auth in `opencode auth login`, not a settings key).
  for (const stale of [
    "opencodeApiKey",
    "piCommand",
    "piArgs",
  ] as const) {
    delete (merged as Record<string, unknown>)[stale];
  }
  // Built-in agent presets register as agents of their own, so their provider
  // ids are taken before the user-defined agents are healed — a custom agent
  // may not shadow "builtin-fast" any more than it may shadow "omp".
  merged.builtinPresets = normalizeBuiltinPresets(
    merged.builtinPresets,
    RESERVED_AGENT_IDS,
  );
  // User-defined agents must be in the registry before the provider fields
  // below are validated — otherwise a freshly added agent is healed away.
  merged.customAgents = normalizeCustomAgents(
    merged.customAgents,
    [...RESERVED_AGENT_IDS, ...presetProviderIds(merged.builtinPresets)],
  );
  setCustomAdapters(merged.customAgents, merged.builtinPresets);
  // Backward-compatible defaults for newly added fields
  if (!merged.ompCommand) merged.ompCommand = DEFAULT_SETTINGS.ompCommand;
  if (!Array.isArray(merged.ompArgs)) {
    merged.ompArgs = [...DEFAULT_SETTINGS.ompArgs];
  }
  if (!merged.opencodeCommand) merged.opencodeCommand = DEFAULT_SETTINGS.opencodeCommand;
  if (!Array.isArray(merged.opencodeArgs)) {
    merged.opencodeArgs = [...DEFAULT_SETTINGS.opencodeArgs];
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
  if (typeof merged.resumeInterruptedTurns !== "boolean") {
    merged.resumeInterruptedTurns = DEFAULT_SETTINGS.resumeInterruptedTurns;
  }
  if (typeof merged.showBootSplash !== "boolean") {
    merged.showBootSplash = DEFAULT_SETTINGS.showBootSplash;
  }
  if (typeof merged.boardTaskAgentPicker !== "boolean") {
    merged.boardTaskAgentPicker = DEFAULT_SETTINGS.boardTaskAgentPicker;
  }
  if (typeof merged.boardTaskModelPicker !== "boolean") {
    merged.boardTaskModelPicker = DEFAULT_SETTINGS.boardTaskModelPicker;
  }
  if (typeof merged.boardTaskEffortPicker !== "boolean") {
    merged.boardTaskEffortPicker = DEFAULT_SETTINGS.boardTaskEffortPicker;
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
  if (typeof merged.chatAutoTitle !== "boolean") {
    merged.chatAutoTitle = DEFAULT_SETTINGS.chatAutoTitle;
  }
  if (typeof merged.boardShowFirstMessage !== "boolean") {
    merged.boardShowFirstMessage = DEFAULT_SETTINGS.boardShowFirstMessage;
  }
  if (typeof merged.chatTitleModel !== "string") {
    merged.chatTitleModel = DEFAULT_SETTINGS.chatTitleModel;
  }
  merged.chatTitleMaxLen = normalizeChatTitleMaxLen(merged.chatTitleMaxLen);
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
  // After the default-model copy above so a legacy builtin default lands
  // already rewritten to its composite `<provider>::<model>` form.
  normalizeBuiltinProviders(merged);
  merged.builtinMaxOutputTokens = normalizeBuiltinMaxOutputTokens(merged.builtinMaxOutputTokens);
  merged.builtinTurnRetryAttempts = normalizeBuiltinTurnRetryAttempts(
    merged.builtinTurnRetryAttempts,
  );
  merged.builtinThinkingLimit = normalizeBuiltinThinkingLimit(merged.builtinThinkingLimit);
  normalizeBuiltinContextSettings(merged);
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
  // Plugin config source: a URL or a local path; empty means the app's own
  // plugins folder, which the loader resolves. Applied at the next server start.
  merged.pluginsConfig =
    typeof merged.pluginsConfig === "string" ? merged.pluginsConfig.trim().slice(0, 2_000) : "";
  merged.pluginProviders = healPluginProviders(merged.pluginProviders);
  merged.pluginEntries = healPluginEntries(merged.pluginEntries);
  // Built-in skill folders: relative to the chat cwd, absolute = global.
  merged.builtinSkillPaths = normalizeSkillPaths(merged.builtinSkillPaths);
  // Per-skill modes: what the agent announces and what it follows from turn 1.
  merged.builtinSkillModes = normalizeSkillModes(merged.builtinSkillModes);
  // Skill folders plugins ship come from the loader on read, never from the
  // database — a stored copy would freeze a plugin's own folder.
  merged.pluginSkills = [];
  // User's own instructions appended to the built-in agent's system prompt.
  merged.builtinExtraInstructions = normalizeBuiltinExtraInstructions(
    merged.builtinExtraInstructions,
  );
  // Built-in agent subagents: row shapes, caps, reserved names.
  merged.builtinSubagents = normalizeBuiltinSubagents(merged.builtinSubagents);
  if (typeof merged.builtinAllowOutsideCwd !== "boolean") {
    merged.builtinAllowOutsideCwd = DEFAULT_SETTINGS.builtinAllowOutsideCwd;
  }
  // Composer drafts persist so typed text survives a reload. Heal the map:
  // only string keys with non-empty trimmed text survive, a bare string is the
  // draft a version before the files knew (its text alone), and the whole blob
  // is capped so it cannot grow without bound.
  {
    const rawDrafts = merged.composerDrafts;
    const drafts: Record<string, ComposerDraft> = {};
    let bytes = 0;
    if (rawDrafts && typeof rawDrafts === "object" && !Array.isArray(rawDrafts)) {
      for (const [key, value] of Object.entries(rawDrafts as Record<string, unknown>)) {
        if (!key.trim()) continue;
        // Ephemeral pre-chat pane tokens are never persisted.
        if (key.startsWith("pane:")) continue;
        const raw = typeof value === "string" ? { text: value } : value;
        if (!raw || typeof raw !== "object") continue;
        const { text: rawText, files: rawFiles } = raw as { text?: unknown; files?: unknown };
        if (typeof rawText !== "string" || !rawText.trim()) continue;
        const files: ComposerDraftFile[] = [];
        if (Array.isArray(rawFiles)) {
          for (const row of rawFiles) {
            if (files.length >= COMPOSER_DRAFT_FILES_MAX) break;
            const { name, path } = (row ?? {}) as { name?: unknown; path?: unknown };
            if (typeof name !== "string" || !name.trim()) continue;
            if (typeof path !== "string" || !path.trim()) continue;
            files.push({ name, path });
          }
        }
        const cost =
          key.length + rawText.length + files.reduce((n, f) => n + f.name.length + f.path.length, 0);
        if (bytes + cost > COMPOSER_DRAFTS_MAX_BYTES) break;
        drafts[key] = { text: rawText, files };
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

/**
 * Providers plugins contribute, registered at boot by the loader. The loader
 * imports this module, so the dependency goes one way: settings never import it.
 */
let pluginProviderSource: ((settings: AppSettings) => BuiltinProviderConfig[]) | null = null;

/** What the plugin loader calls once it has loaded its bundles. */
export function setPluginProviderSource(
  source: (settings: AppSettings) => BuiltinProviderConfig[],
): void {
  pluginProviderSource = source;
}

/** Skill folders plugins ship, registered at boot the same way as providers. */
let pluginSkillSource: (() => PluginSkillFolder[]) | null = null;

/** What the plugin loader calls with the folders its `skillPath` contributions name. */
export function setPluginSkillSource(source: () => PluginSkillFolder[]): void {
  pluginSkillSource = source;
}

/**
 * Plugins added by hand. A row that still lacks its id or its path is kept —
 * the loader is the one that reports it, and dropping it here would make a
 * half-typed row vanish under the user's cursor on the next save.
 */
function healPluginEntries(raw: unknown): PluginEntryConfig[] {
  const out: PluginEntryConfig[] = [];
  if (!Array.isArray(raw)) return out;
  for (const value of raw.slice(0, 200)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim().toLowerCase().slice(0, 64) : "";
    const server = typeof row.server === "string" ? row.server.trim().slice(0, 2_000) : "";
    if (!id && !server) continue;
    out.push({
      id,
      server,
      ...(typeof row.version === "string" && row.version.trim()
        ? { version: row.version.trim().slice(0, 64) }
        : {}),
      ...(row.enabled === false ? { enabled: false as const } : {}),
      ...(row.config && typeof row.config === "object" && !Array.isArray(row.config)
        ? { config: row.config as Record<string, unknown> }
        : {}),
    });
  }
  return out;
}

/** Rows the user can edit about a provider a plugin ships, keyed `<plugin>:<id>`. */
function healPluginProviders(raw: unknown): Record<string, PluginProviderOverride> {
  const out: Record<string, PluginProviderOverride> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim().slice(0, 128);
    if (!id || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const models = normalizeBuiltinModelRows(row.models);
    out[id] = {
      ...(typeof row.apiKey === "string" ? { apiKey: row.apiKey.trim().slice(0, 500) } : {}),
      ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
      ...(typeof row.urlOverride === "string"
        ? { urlOverride: row.urlOverride.trim().slice(0, 500) }
        : {}),
      ...(models.length ? { models } : {}),
    };
  }
  return out;
}

/** Settings as the app reads them: the stored row plus what the plugins add. */
export async function getSettings(): Promise<AppSettings> {
  return withPluginSkills(withPluginProviders(await readStoredSettings()));
}

/**
 * The stored settings alone. Write paths must use this: a settings object that
 * went through `getSettings` carries plugin rows, and persisting it would store
 * a stale copy of a plugin's own endpoint and models.
 */
async function readStoredSettings(): Promise<AppSettings> {
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

/** Providers a plugin contributes, ready for every reader of the settings. */
function withPluginProviders(settings: AppSettings): AppSettings {
  // The source reads the stored half (its own rows are `pluginProviders`), so it
  // is handed these settings rather than asked to read them again.
  const contributed = pluginProviderSource?.(settings) ?? [];
  if (!contributed.length) return settings;
  return { ...settings, builtinProviders: [...settings.builtinProviders, ...contributed] };
}

/** Skill folders a plugin ships, ready for every reader of the settings. */
function withPluginSkills(settings: AppSettings): AppSettings {
  const contributed = pluginSkillSource?.() ?? [];
  return contributed.length ? { ...settings, pluginSkills: [...contributed] } : settings;
}

/** Marker written into a settings file; foreign JSON is refused by it. */
export const SETTINGS_FILE_KIND = "acpio-settings";
export const SETTINGS_FILE_VERSION = 1;

/** A settings file: what one install exports and another applies whole. */
export type SettingsFile = {
  kind: typeof SETTINGS_FILE_KIND;
  version: number;
  exportedAt: string;
  settings: Record<string, unknown>;
};

/**
 * Credentials never travel: a settings file goes from one person to another,
 * and the keys one of them pays for stay theirs — an import leaves the local
 * wallet untouched instead of replacing it with a stranger's (or an empty) one.
 */
const SECRET_SETTING_KEYS = [
  "cursorApiKey",
  "anthropicApiKey",
  "openaiApiKey",
  "remoteAccessKey",
] as const;

/** One MCP server without the token/env/headers it authenticates with. */
function stripMcpSecrets(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const {
    token: _token,
    headers: _headers,
    remoteConfig: _remoteConfig,
    env: _env,
    envConfig: _envConfig,
    ...rest
  } = raw as Record<string, unknown>;
  return rest;
}

/**
 * A settings bag without what must not travel — the shape both directions use,
 * so a hand-edited file carrying a key can no more overwrite the local one than
 * an export can leak it.
 */
function stripSecrets(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...bag };
  for (const key of SECRET_SETTING_KEYS) delete out[key];
  // Typed drafts are one user's own text, not a setting anyone inherits.
  delete out.composerDrafts;
  // Providers (the endpoints, their models and the key each pays with) are the
  // machine's own setup: they are neither written into a file nor taken from
  // one, so an import leaves the local list exactly as it was.
  delete out.builtinProviders;
  delete out.pluginProviders;
  if (Array.isArray(out.mcpServers)) {
    out.mcpServers = out.mcpServers.map(stripMcpSecrets);
  }
  const folders = out.mcpFolderConfigs;
  if (folders && typeof folders === "object" && !Array.isArray(folders)) {
    out.mcpFolderConfigs = Object.fromEntries(
      Object.entries(folders as Record<string, unknown>).map(([cwd, cfg]) => {
        const row =
          cfg && typeof cfg === "object" && !Array.isArray(cfg)
            ? (cfg as Record<string, unknown>)
            : {};
        return [
          cwd,
          {
            ...row,
            ...(Array.isArray(row.servers)
              ? { servers: row.servers.map(stripMcpSecrets) }
              : {}),
          },
        ];
      }),
    );
  }
  return out;
}

/** Settings a file may carry: the stored half, credentials and providers left behind. */
export async function buildSettingsFile(): Promise<SettingsFile> {
  // The stored rows, never `getSettings`: what a plugin contributes is the
  // plugin's, and a file must not freeze a copy of it.
  const stored = await readStoredSettings();
  return {
    kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    settings: stripSecrets({ ...stored }),
  };
}

export type SettingsImportResult = {
  settings: AppSettings;
  /** Settings the file actually applied, by top-level key. */
  applied: string[];
};

/** Keys a settings file may set — anything else is not a setting of this app. */
const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

/**
 * Credentials one local MCP server authenticates with, keyed by its id: a row
 * that comes back from a file is the same server with the same wallet.
 */
function localMcpSecrets(
  rows: readonly McpServerConfig[],
  id: unknown,
): Record<string, unknown> {
  const row = rows.find((s) => s.id === id);
  if (!row) return {};
  return {
    ...(row.token !== undefined ? { token: row.token } : {}),
    ...(row.headers ? { headers: row.headers } : {}),
    ...(row.remoteConfig !== undefined ? { remoteConfig: row.remoteConfig } : {}),
    ...(row.env ? { env: row.env } : {}),
    ...(row.envConfig !== undefined ? { envConfig: row.envConfig } : {}),
  };
}

/**
 * Give every row of an imported MCP list the credentials the local row with
 * that id holds: the file gets to say what a server IS (url, switches) and
 * nothing about what it pays with. A row the local install does not know
 * arrives without one — it is the importing user's to fill.
 */
function withLocalSecrets(
  patch: Record<string, unknown>,
  current: AppSettings,
): Record<string, unknown> {
  const out = { ...patch };
  if (Array.isArray(out.mcpServers)) {
    const global = current.mcpServers;
    out.mcpServers = (out.mcpServers as unknown[]).map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return row;
      const r = row as Record<string, unknown>;
      return { ...localMcpSecrets(global, r.id), ...r };
    });
  }
  const folders = out.mcpFolderConfigs;
  if (folders && typeof folders === "object" && !Array.isArray(folders)) {
    out.mcpFolderConfigs = Object.fromEntries(
      Object.entries(folders as Record<string, unknown>).map(([cwd, cfg]) => {
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [cwd, cfg];
        const row = cfg as Record<string, unknown>;
        if (!Array.isArray(row.servers)) return [cwd, row];
        const known = [
          ...(current.mcpFolderConfigs[cwd]?.servers ?? []),
          ...current.mcpServers,
        ];
        return [
          cwd,
          {
            ...row,
            servers: (row.servers as unknown[]).map((server) => {
              if (!server || typeof server !== "object" || Array.isArray(server)) {
                return server;
              }
              const s = server as Record<string, unknown>;
              return { ...localMcpSecrets(known, s.id), ...s };
            }),
          },
        ];
      }),
    );
  }
  return out;
}

/**
 * Apply a settings file: every setting it carries lands, its credentials and
 * its providers are ignored (the local ones survive), and the ordinary merge
 * heals whatever this app version no longer knows.
 */
export async function importSettingsFile(raw: unknown): Promise<SettingsImportResult> {
  const outer = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const bag = (outer as { settings?: unknown }).settings;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    throw new Error("settings file: no settings object");
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stripSecrets(bag as Record<string, unknown>))) {
    if (!SETTING_KEYS.has(key)) continue;
    patch[key] = value;
  }
  // The theme is the one field the merge spreads unchecked, so a typo in a
  // hand-edited file would otherwise be stored and painted as "no theme".
  if (patch.theme !== undefined && patch.theme !== "light" && patch.theme !== "dark") {
    delete patch.theme;
  }
  const withSecrets = withLocalSecrets(patch, await readStoredSettings());
  const settings = await updateSettings(withSecrets as Partial<AppSettings>);
  return { settings, applied: Object.keys(patch) };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readStoredSettings();
  const next = mergeSettings({
    ...current,
    ...patch,
    // A form submit carries the whole provider list, plugin rows included —
    // those are merged in on read and must never reach the database.
    builtinProviders: (patch.builtinProviders ?? current.builtinProviders).filter(
      (p) => !p.pluginId,
    ),
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
