import { eq } from "drizzle-orm";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  normalizeChatMetaChips,
  readSettingsSchema,
} from "@acpio/shared";
import { db, REPO_ROOT } from "../db/client.js";
import { settings } from "../db/schema.js";
import { adapters } from "../adapters/registry.js";
import { syncDeepLoggingFromSettings } from "./deepLogging.js";

const SETTINGS_KEY = "app";

/** True when the provider is a registered harness adapter. */
function isKnownProvider(provider: unknown): provider is string {
  return typeof provider === "string" && adapters.ids().includes(provider);
}

/** Keep only valid config ids, healing rows saved before an id was removed.
 *  An empty result is valid (the user may disable every item). */
function filterValid<T extends string>(values: unknown[], valid: T[]): T[] {
  return values.filter((v): v is T => typeof v === "string" && valid.includes(v as T));
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
  if (typeof merged.chatSplit !== "boolean") {
    merged.chatSplit = DEFAULT_SETTINGS.chatSplit;
  }
  merged.chatToolbarStyle =
    merged.chatToolbarStyle === "minimal" ? "minimal" : DEFAULT_SETTINGS.chatToolbarStyle;
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
  if (!Array.isArray(merged.mcpServers)) {
    merged.mcpServers = [];
  } else {
    merged.mcpServers = merged.mcpServers.filter(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        (s.type === "local" || s.type === "remote"),
    );
  }
  return merged;
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (!rows[0]) {
    const seeded = mergeSettings({
      defaultCwd: process.env.DEFAULT_CWD || REPO_ROOT,
      cursorApiKey: process.env.CURSOR_API_KEY ?? "",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    });
    await db.insert(settings).values({ key: SETTINGS_KEY, value: seeded });
    syncDeepLoggingFromSettings(seeded);
    return seeded;
  }
  const merged = mergeSettings(rows[0].value);
  syncDeepLoggingFromSettings(merged);
  return merged;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch, settingsSchema: SETTINGS_SCHEMA_VERSION });
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: new Date() },
    });
  syncDeepLoggingFromSettings(next);
  return next;
}
