import {
  DEFAULT_CHAT_CHIP_OPTIONS,
  DEFAULT_SETTINGS,
  normalizeMcpProjectFiles,
  type AgentProvider,
  type AppSettings,
  type ChatChangesMetrics,
  type ChatChipOptions,
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

/** Upper bound for the chat-tree "newest chats per folder" cap. */
export const CHAT_TREE_RECENT_LIMIT_MAX = 200;

/**
 * Heal the chat-tree "newest chats per folder" cap. Anything not a finite
 * number falls back to the default; negatives clamp to 0 (= show all).
 */
export function normalizeChatTreeRecentLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.chatTreeRecentLimit;
  }
  return Math.min(CHAT_TREE_RECENT_LIMIT_MAX, Math.max(0, Math.round(value)));
}

const CHAT_CHANGES_METRICS: ChatChangesMetrics[] = [
  "none",
  "lines",
  "files",
  "linesAndFiles",
];

/**
 * Deep-merge a partial per-chip patch onto an existing options object. Used by
 * both the settings form (one chip saved at a time) and load-time healing, so
 * a partial object never resets the chips it does not mention.
 */
export function mergeChatChipOptions(base: ChatChipOptions, patch: unknown): ChatChipOptions {
  const raw = (patch && typeof patch === "object" ? patch : {}) as Partial<
    Record<keyof ChatChipOptions, unknown>
  >;
  const folder = (raw.folder ?? {}) as { compress?: unknown; truncate?: unknown };
  const gitBranch = (raw.gitBranch ?? {}) as { compress?: unknown };
  const gitChanges = (raw.gitChanges ?? {}) as { compress?: unknown; metrics?: unknown };
  const context = (raw.context ?? {}) as { format?: unknown };
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  return {
    folder: {
      compress: bool(folder.compress, base.folder.compress),
      truncate: pick(folder.truncate, ["middle", "end"] as const, base.folder.truncate),
    },
    gitBranch: { compress: bool(gitBranch.compress, base.gitBranch.compress) },
    gitChanges: {
      compress: bool(gitChanges.compress, base.gitChanges.compress),
      metrics: pick(gitChanges.metrics, CHAT_CHANGES_METRICS, base.gitChanges.metrics),
    },
    context: {
      format: pick(context.format, ["usage", "percent"] as const, base.context.format),
    },
  };
}

/** Heal a stored per-chip options object against the defaults. */
export function normalizeChatChipOptions(value: unknown): ChatChipOptions {
  return mergeChatChipOptions(DEFAULT_CHAT_CHIP_OPTIONS, value);
}

/** Client-side merge: defaults + API payload with chip migration. */
export function mergeClientAppSettings(raw: unknown): AppSettings {
  const partial =
    raw && typeof raw === "object" ? (raw as Partial<AppSettings>) : ({} as Partial<AppSettings>);
  const schemaVersion = readSettingsSchema(raw);
  const merged: AppSettings = { ...DEFAULT_SETTINGS, ...partial };
  merged.chatMetaChips = normalizeChatMetaChips(partial.chatMetaChips, schemaVersion);
  merged.chatToolbarStyle = normalizeChatToolbarStyle(partial.chatToolbarStyle);
  // Anything but an explicit "server" falls back to the device default.
  merged.attachDefaultSource = partial.attachDefaultSource === "server" ? "server" : "device";
  merged.chatGitBranchPosition = normalizeChatGitBranchPosition(partial.chatGitBranchPosition);
  merged.chatTreeRecentLimit = normalizeChatTreeRecentLimit(partial.chatTreeRecentLimit);
  merged.chatChipOptions = normalizeChatChipOptions(partial.chatChipOptions);
  merged.mcpProjectFiles = normalizeMcpProjectFiles(partial.mcpProjectFiles);
  if (typeof partial.diagnosticsDeepLogging !== "boolean") {
    merged.diagnosticsDeepLogging = DEFAULT_SETTINGS.diagnosticsDeepLogging;
  }
  merged.terminalShell =
    partial.terminalShell === "powershell" ? "powershell" : DEFAULT_SETTINGS.terminalShell;
  merged.disabledProviders = Array.isArray(partial.disabledProviders)
    ? partial.disabledProviders.filter((id): id is AgentProvider => typeof id === "string")
    : [...DEFAULT_SETTINGS.disabledProviders];
  merged.settingsSchema = SETTINGS_SCHEMA_VERSION;
  return merged;
}
