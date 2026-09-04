import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ChatMetaChipId,
  type ChatToolbarStyle,
} from "./index.js";

/** Bumped when persisted settings need a one-time migration on load. */
export const SETTINGS_SCHEMA_VERSION = 5;

const CHAT_META_CHIP_IDS: ChatMetaChipId[] = [
  "folder",
  "gitBranch",
  "gitChanges",
  "thoughts",
  "mcp",
  "context",
  "console",
];
const DEFAULT_CHAT_META_CHIPS: ChatMetaChipId[] = [...CHAT_META_CHIP_IDS];

function expandLegacyGitChip(chips: string[]): ChatMetaChipId[] {
  const out: ChatMetaChipId[] = [];
  for (const chip of chips) {
    if (chip === "git") {
      out.push("gitBranch", "gitChanges");
      continue;
    }
    if (CHAT_META_CHIP_IDS.includes(chip as ChatMetaChipId)) {
      out.push(chip as ChatMetaChipId);
    }
  }
  return out;
}

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
  const raw = Array.isArray(chips)
    ? chips.filter((v): v is string => typeof v === "string")
    : [...DEFAULT_CHAT_META_CHIPS];

  let next = expandLegacyGitChip(raw);

  if (schemaVersion < 2 && !next.includes("console")) {
    next = [...next, "console"];
  }
  if (schemaVersion < 3 && !next.includes("gitBranch") && !next.includes("gitChanges")) {
    const folderIdx = next.indexOf("folder");
    const gitPair: ChatMetaChipId[] = ["gitBranch", "gitChanges"];
    next =
      folderIdx >= 0
        ? [...next.slice(0, folderIdx + 1), ...gitPair, ...next.slice(folderIdx + 1)]
        : [...gitPair, ...next];
  }
  if (schemaVersion < 5) {
    next = expandLegacyGitChip(next);
  }

  const seen = new Set<ChatMetaChipId>();
  return next.filter((chip) => {
    if (!CHAT_META_CHIP_IDS.includes(chip) || seen.has(chip)) return false;
    seen.add(chip);
    return true;
  });
}

export function normalizeChatToolbarStyle(value: unknown): ChatToolbarStyle {
  return value === "minimal" ? "minimal" : DEFAULT_SETTINGS.chatToolbarStyle;
}

export function normalizeChatGitBranchPosition(value: unknown): "below" | "above" {
  return value === "above" ? "above" : "below";
}

/** Client-side merge: defaults + API payload with chip migration. */
export function mergeClientAppSettings(raw: unknown): AppSettings {
  const partial =
    raw && typeof raw === "object" ? (raw as Partial<AppSettings>) : ({} as Partial<AppSettings>);
  const schemaVersion = readSettingsSchema(raw);
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...partial };
  merged.chatMetaChips = normalizeChatMetaChips(partial.chatMetaChips, schemaVersion);
  merged.chatToolbarStyle = normalizeChatToolbarStyle(partial.chatToolbarStyle);
  merged.chatGitBranchPosition = normalizeChatGitBranchPosition(partial.chatGitBranchPosition);
  if (typeof partial.diagnosticsDeepLogging !== "boolean") {
    merged.diagnosticsDeepLogging = DEFAULT_SETTINGS.diagnosticsDeepLogging;
  }
  merged.terminalShell =
    partial.terminalShell === "powershell" ? "powershell" : DEFAULT_SETTINGS.terminalShell;
  merged.settingsSchema = SETTINGS_SCHEMA_VERSION;
  return merged;
}
