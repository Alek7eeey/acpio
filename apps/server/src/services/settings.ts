import { eq } from "drizzle-orm";
import {
  AppSettings,
  DEFAULT_SETTINGS,
} from "@acprocess/shared";
import { db, REPO_ROOT } from "../db/client.js";
import { settings } from "../db/schema.js";
import { adapters } from "../adapters/registry.js";

const SETTINGS_KEY = "app";

/** True when the provider is a registered harness adapter. */
function isKnownProvider(provider: unknown): provider is string {
  return typeof provider === "string" && adapters.ids().includes(provider);
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
  if (merged.ttsVoiceGender !== "female" && merged.ttsVoiceGender !== "male") {
    merged.ttsVoiceGender = "";
  }
  if (!Array.isArray(merged.chatActions)) {
    merged.chatActions = [...DEFAULT_SETTINGS.chatActions];
  }
  if (!Array.isArray(merged.chatMetaChips)) {
    merged.chatMetaChips = [...DEFAULT_SETTINGS.chatMetaChips];
  }
  if (typeof merged.chatReadAloud !== "boolean") {
    merged.chatReadAloud = DEFAULT_SETTINGS.chatReadAloud;
  }
  if (typeof merged.chatEnterToSend !== "boolean") {
    merged.chatEnterToSend = DEFAULT_SETTINGS.chatEnterToSend;
  }
  if (typeof merged.chatShowMessageTime !== "boolean") {
    merged.chatShowMessageTime = DEFAULT_SETTINGS.chatShowMessageTime;
  }
  if (typeof merged.chatVoiceInput !== "boolean") {
    merged.chatVoiceInput = DEFAULT_SETTINGS.chatVoiceInput;
  }
  if (typeof merged.chatTreeShowArchive !== "boolean") {
    merged.chatTreeShowArchive = DEFAULT_SETTINGS.chatTreeShowArchive;
  }
  if (merged.chatTreeDensity !== "cozy" && merged.chatTreeDensity !== "compact") {
    merged.chatTreeDensity = DEFAULT_SETTINGS.chatTreeDensity;
  }
  if (!Array.isArray(merged.chatTreeElements)) {
    merged.chatTreeElements = [...DEFAULT_SETTINGS.chatTreeElements];
  }
  if (
    merged.chatHeaderSize !== "compact" &&
    merged.chatHeaderSize !== "default" &&
    merged.chatHeaderSize !== "roomy"
  ) {
    merged.chatHeaderSize = DEFAULT_SETTINGS.chatHeaderSize;
  }
  if (
    merged.chatToolbarSize !== "compact" &&
    merged.chatToolbarSize !== "default" &&
    merged.chatToolbarSize !== "roomy"
  ) {
    merged.chatToolbarSize = DEFAULT_SETTINGS.chatToolbarSize;
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
    return seeded;
  }
  return mergeSettings(rows[0].value);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: next, updatedAt: new Date() },
    });
  return next;
}
