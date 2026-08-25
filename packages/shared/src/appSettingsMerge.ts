import { DEFAULT_SETTINGS, type AppSettings, type ChatMetaChipId, type ChatToolbarStyle } from "./index.js";

/** Bumped when persisted settings need a one-time migration on load. */
export const SETTINGS_SCHEMA_VERSION = 2;

const CHAT_META_CHIP_IDS: ChatMetaChipId[] = ["folder", "thoughts", "mcp", "context", "console"];
const DEFAULT_CHAT_META_CHIPS: ChatMetaChipId[] = [...CHAT_META_CHIP_IDS];

export function readSettingsSchema(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 1;
  const v = (raw as Record<string, unknown>).settingsSchema;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 1;
}

/** Normalize composer meta chips and migrate new defaults for older saved settings. */
export function normalizeChatMetaChips(
  chips: unknown,
  schemaVersion: number,
): ChatMetaChipId[] {
  const valid = Array.isArray(chips)
    ? chips.filter(
        (v): v is ChatMetaChipId =>
          typeof v === "string" && CHAT_META_CHIP_IDS.includes(v as ChatMetaChipId),
      )
    : [...DEFAULT_CHAT_META_CHIPS];

  if (schemaVersion < SETTINGS_SCHEMA_VERSION && !valid.includes("console")) {
    return [...valid, "console"];
  }
  return valid;
}

export function normalizeChatToolbarStyle(value: unknown): ChatToolbarStyle {
  return value === "minimal" ? "minimal" : DEFAULT_SETTINGS.chatToolbarStyle;
}

/** Client-side merge: defaults + API payload with chip migration. */
export function mergeClientAppSettings(raw: unknown): AppSettings {
  const partial =
    raw && typeof raw === "object" ? (raw as Partial<AppSettings>) : ({} as Partial<AppSettings>);
  const schemaVersion = readSettingsSchema(raw);
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...partial };
  merged.chatMetaChips = normalizeChatMetaChips(partial.chatMetaChips, schemaVersion);
  merged.chatToolbarStyle = normalizeChatToolbarStyle(partial.chatToolbarStyle);
  merged.settingsSchema = SETTINGS_SCHEMA_VERSION;
  return merged;
}
