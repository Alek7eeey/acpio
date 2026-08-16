import { eq } from "drizzle-orm";
import {
  AppSettings,
  DEFAULT_SETTINGS,
} from "@acprocess/shared";
import { db, REPO_ROOT } from "../db/client.js";
import { settings } from "../db/schema.js";

const SETTINGS_KEY = "app";

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
  if (merged.defaultProvider !== "cursor" && merged.defaultProvider !== "omp") {
    merged.defaultProvider = DEFAULT_SETTINGS.defaultProvider;
  }
  if (merged.locale !== "en" && merged.locale !== "ru") {
    merged.locale = DEFAULT_SETTINGS.locale;
  }
  if (typeof merged.displayName !== "string") {
    merged.displayName = DEFAULT_SETTINGS.displayName;
  }
  if (
    merged.connectedProvider !== null &&
    merged.connectedProvider !== "cursor" &&
    merged.connectedProvider !== "omp"
  ) {
    merged.connectedProvider = DEFAULT_SETTINGS.connectedProvider;
  }
  if (typeof merged.diagnosticsDir !== "string") {
    merged.diagnosticsDir = DEFAULT_SETTINGS.diagnosticsDir;
  }
  if (typeof merged.exportDir !== "string") {
    merged.exportDir = DEFAULT_SETTINGS.exportDir;
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
