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
  // Backward-compatible defaults for newly added fields
  if (!merged.ompCommand) merged.ompCommand = DEFAULT_SETTINGS.ompCommand;
  if (!Array.isArray(merged.ompArgs)) {
    merged.ompArgs = [...DEFAULT_SETTINGS.ompArgs];
  }
  if (!merged.piCommand) merged.piCommand = DEFAULT_SETTINGS.piCommand;
  if (!Array.isArray(merged.piArgs)) {
    merged.piArgs = [...DEFAULT_SETTINGS.piArgs];
  }
  if (merged.defaultProvider !== "cursor" &&
    merged.defaultProvider !== "opencode" &&
    merged.defaultProvider !== "omp" &&
    merged.defaultProvider !== "pi"
  ) {
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
    merged.connectedProvider !== "opencode" &&
    merged.connectedProvider !== "omp" &&
    merged.connectedProvider !== "pi"
  ) {
    merged.connectedProvider = DEFAULT_SETTINGS.connectedProvider;
  }
  return merged;
}

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (!rows[0]) {
    const seeded = mergeSettings({
      defaultCwd: process.env.DEFAULT_CWD || REPO_ROOT,
      cursorApiKey: process.env.CURSOR_API_KEY ?? "",
      opencodeApiKey: process.env.OPENCODE_API_KEY ?? "",
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
      openaiApiKey: process.env.OPENAI_API_KEY ?? "",
      giteaBaseUrl: process.env.GITEA_BASE_URL ?? "http://localhost:3000",
      giteaToken: process.env.GITEA_TOKEN ?? "",
      giteaOwner: process.env.GITEA_OWNER ?? "acprocess",
      giteaRepo: process.env.GITEA_REPO ?? "demo",
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
