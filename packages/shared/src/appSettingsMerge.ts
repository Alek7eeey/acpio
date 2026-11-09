import {
  BUILTIN_PRESET_MAX,
  normalizeCustomAgentId,
  type BuiltinPresetSpec,
} from "./adapters.js";
import {
  DEFAULT_CHAT_CHIP_OPTIONS,
  DEFAULT_EDITOR_KEYS,
  DEFAULT_SETTINGS,
  normalizeEditorKeyCombo,
  normalizeEditorNavPlacement,
  normalizeEditorSplit,
  normalizeEditorTheme,
  normalizeEditorToolSource,
  normalizeFileOpenTarget,
  normalizeBuiltinProviders,
  normalizeBuiltinSubagents,
  normalizeMcpProjectFiles,
  normalizeSkillModes,
  normalizeBuiltinProjectRules,
  normalizeIgnoreFiles,
  normalizeSkillPaths,
  type AgentProvider,
  type AppSettings,
  type BuiltinContextMode,
  type BuiltinReasoningPolicy,
  type BuiltinReplyLanguage,
  type ChatChangesMetrics,
  type ChatChipOptions,
  type ChatMetaChipId,
  type ChatTreeMenuId,
  type ChatToolbarStyle,
} from "./index.js";

/** Bumped when persisted settings need a one-time migration on load. */
export const SETTINGS_SCHEMA_VERSION = 9;

const CHAT_META_CHIP_IDS: ChatMetaChipId[] = [
  "folder",
  "board",
  "gitBranch",
  "gitChanges",
  "thoughts",
  "mcp",
  "context",
  "console",
  "bgJobs",
];
/** A file without a chip list gets the row the app ships, not every chip.
 *  Read at call time: `index.ts` imports this module, so its defaults are still
 *  missing while this file is being evaluated. */
const defaultChatMetaChips = (): ChatMetaChipId[] => [...DEFAULT_SETTINGS.chatMetaChips];

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
    : [...defaultChatMetaChips()];

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
  if (schemaVersion < 6 && !next.includes("board")) {
    const folderIdx = next.indexOf("folder");
    next =
      folderIdx >= 0
        ? [...next.slice(0, folderIdx + 1), "board", ...next.slice(folderIdx + 1)]
        : ["board", ...next];
  }
  // The background-task chip arrived last, so it joins saved lists at the end
  // — where the default list keeps it.
  if (schemaVersion < 7 && !next.includes("bgJobs")) {
    next = [...next, "bgJobs"];
  }
  // The agent turn timeline draws the reasoning in place (schema 9), so the
  // "Размышления" chip left the default row: a list saved before it gives the
  // chip up once instead of keeping a switch the timeline made redundant.
  if (schemaVersion < 9) {
    next = next.filter((chip) => chip !== "thoughts");
  }

  const seen = new Set<ChatMetaChipId>();
  return next.filter((chip) => {
    if (!CHAT_META_CHIP_IDS.includes(chip) || seen.has(chip)) return false;
    seen.add(chip);
    return true;
  });
}

/**
 * The agent turn timeline became the default reading of a turn (schema 9). A
 * stored boolean cannot pick a new default up on its own — every install that
 * ever saved its settings carries the old `false` — so it is flipped once, and
 * a value saved after that (the switch is off in the UI) stays as it is.
 */
export function normalizeChatAgentTurnTimeline(value: unknown, schemaVersion: number): boolean {
  if (schemaVersion < 9) return true;
  return value === true;
}

const CHAT_TREE_MENU_IDS: ChatTreeMenuId[] = ["rename", "move", "export", "share", "delete"];

/**
 * Normalize the tree's "⋯" commands and migrate a new one into saved
 * settings. "share" arrived with schema 8, so a stored list opens with it
 * placed where the default keeps it — but a list the reader emptied on
 * purpose stays empty: the "⋯" button is what they meant to hide.
 */
export function normalizeChatTreeMenu(raw: unknown, schemaVersion: number): ChatTreeMenuId[] {
  const list = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : [...CHAT_TREE_MENU_IDS];
  let next = list.filter((id): id is ChatTreeMenuId =>
    CHAT_TREE_MENU_IDS.includes(id as ChatTreeMenuId),
  );
  if (schemaVersion < 8 && next.length > 0 && !next.includes("share")) {
    const deleteIdx = next.indexOf("delete");
    next =
      deleteIdx >= 0
        ? [...next.slice(0, deleteIdx), "share", ...next.slice(deleteIdx)]
        : [...next, "share"];
  }
  const seen = new Set<ChatTreeMenuId>();
  return next.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function normalizeChatToolbarStyle(value: unknown): ChatToolbarStyle {
  return value === "minimal" ? "minimal" : DEFAULT_SETTINGS.chatToolbarStyle;
}

export function normalizeBoardAddCardStyle(value: unknown): AppSettings["boardAddCardStyle"] {
  return value === "compact" || value === "hidden"
    ? value
    : DEFAULT_SETTINGS.boardAddCardStyle;
}

/** The board's task agent picker is on unless it was explicitly switched off. */
export function normalizeBoardTaskAgentPicker(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.boardTaskAgentPicker;
}

export function normalizeBoardTaskModelPicker(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.boardTaskModelPicker;
}

export function normalizeBoardTaskEffortPicker(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.boardTaskEffortPicker;
}

export function normalizeChatGitBranchPosition(value: unknown): "below" | "above" {
  return value === "above" ? "above" : "below";
}

/** Bounds for the model-written chat title length, in characters. */
export const CHAT_TITLE_MAX_LEN_MIN = 20;
export const CHAT_TITLE_MAX_LEN_MAX = 200;

/**
 * Heal the model-written chat title length. Anything not a finite number falls
 * back to the default; the value clamps to a range where a title is still a
 * title and still fits the chat list.
 */
export function normalizeChatTitleMaxLen(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.chatTitleMaxLen;
  }
  return Math.min(CHAT_TITLE_MAX_LEN_MAX, Math.max(CHAT_TITLE_MAX_LEN_MIN, Math.round(value)));
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

/** Upper bound for the built-in agent's per-call output ceiling. */
export const BUILTIN_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

/**
 * Heal the built-in agent's output ceiling. Anything not a finite number falls
 * back to the default; 0 is kept as "no ceiling" — the same idiom as
 * {@link normalizeChatTreeRecentLimit} — and negatives clamp to it.
 */
export function normalizeBuiltinMaxOutputTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinMaxOutputTokens;
  }
  return Math.min(BUILTIN_MAX_OUTPUT_TOKENS_MAX, Math.max(0, Math.round(value)));
}

/** Bounds for one built-in turn's attempts (1 = never retry). */
export const BUILTIN_TURN_RETRY_ATTEMPTS_MIN = 1;
export const BUILTIN_TURN_RETRY_ATTEMPTS_MAX = 10;

/**
 * Heal the built-in agent's turn attempts. Anything not a finite number falls
 * back to the default; 1 means "run once, never retry", so lower values clamp
 * up to it.
 */
export function normalizeBuiltinTurnRetryAttempts(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinTurnRetryAttempts;
  }
  return Math.min(
    BUILTIN_TURN_RETRY_ATTEMPTS_MAX,
    Math.max(BUILTIN_TURN_RETRY_ATTEMPTS_MIN, Math.round(value)),
  );
}

/** Upper bound for the mid-think fuse cap, in chars of one step's reasoning. */
export const BUILTIN_THINKING_LIMIT_MAX = 1_000_000;

/**
 * Heal the built-in agent's mid-think fuse cap. Anything not a finite number
 * falls back to the default; 0 is kept as "fuse off" — the same idiom as
 * {@link normalizeBuiltinMaxOutputTokens} — and negatives clamp to it.
 */
export function normalizeBuiltinThinkingLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinThinkingLimit;
  }
  return Math.min(BUILTIN_THINKING_LIMIT_MAX, Math.max(0, Math.round(value)));
}

/** Bounds for the built-in agent's bash timeout, in seconds. */
export const BUILTIN_BASH_TIMEOUT_SEC_MIN = 5;
export const BUILTIN_BASH_TIMEOUT_SEC_MAX = 300;

/**
 * Longest a single terminal wait may run: the ceiling on `bash`'s `timeout_ms`
 * and the host's own clamp on `terminal/wait_for_exit`. It is deliberately
 * above the setting's default ceiling — a build or a test run may name its own
 * bigger limit for one call — but it is not open-ended: a command that waits for
 * input never ends by itself, and the cap is what gives the model control back
 * instead of leaving the turn parked until someone presses Stop.
 */
export const TERMINAL_WAIT_MAX_MS = 1_800_000;

/**
 * Longest one background-job wait may block — the same ceiling `bash` has, so a
 * job can be waited on as long as a command could be slept on. It used to be
 * 170 s, under the MCP client's 180 s per-call limit, and a wait shorter than
 * the work it waits for taught the model to poll with `sleep` instead
 * (`bgMcp.ts` says so itself in the note it leaves for a job that outlives a
 * call). Whichever client calls `job` must give the call at least this long.
 */
export const BG_JOB_MAX_WAIT_MS = TERMINAL_WAIT_MAX_MS;

/**
 * Heal the built-in agent's bash timeout. Anything not a finite number falls
 * back to the default; a command needs a moment to fail, so a lower value clamps
 * up to the minimum the harness itself enforces on `terminal/wait_for_exit`.
 */
export function normalizeBuiltinBashTimeoutSec(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinBashTimeoutSec;
  }
  return Math.min(
    BUILTIN_BASH_TIMEOUT_SEC_MAX,
    Math.max(BUILTIN_BASH_TIMEOUT_SEC_MIN, Math.round(value)),
  );
}

/** Bounds for the built-in agent's compaction knobs. */
export const BUILTIN_COMPACTION_THRESHOLD_PERCENT_MIN = 10;
export const BUILTIN_COMPACTION_THRESHOLD_PERCENT_MAX = 95;
export const BUILTIN_KEEP_RECENT_PERCENT_MIN = 10;
export const BUILTIN_KEEP_RECENT_PERCENT_MAX = 90;
export const BUILTIN_MAX_SUMMARY_TOKENS_MAX = 1_000_000;
export const BUILTIN_PRUNE_TOOL_RESULTS_KEEP_LAST_MAX = 100;

/** How far the verbatim tail must stay below the trigger, in percent of the window. */
const BUILTIN_TAIL_HEADROOM_PERCENT = 10;

/** Heal one bounded percent knob: no finite number falls back to the default. */
function normalizeBoundedPercent(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Heal the offload threshold; 0 is kept as "off". */
export function normalizeBuiltinOffloadToolResultTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinOffloadToolResultTokens;
  }
  return Math.min(BUILTIN_MAX_SUMMARY_TOKENS_MAX, Math.max(0, Math.round(value)));
}

/** Heal the reasoning policy. An unknown string falls back to the default. */
export function normalizeBuiltinPruneReasoning(value: unknown): BuiltinReasoningPolicy {
  return value === "keep" || value === "before-last-message" || value === "drop"
    ? value
    : DEFAULT_SETTINGS.builtinPruneReasoning;
}

/** Heal the context-window policy. An unknown string falls back to the default. */
export function normalizeBuiltinContextMode(value: unknown): BuiltinContextMode {
  return value === "off" || value === "prune" || value === "summary"
    ? value
    : DEFAULT_SETTINGS.builtinContextMode;
}

/**
 * Heal the answer language (Settings → Built-in agent). Anything that is not
 * one of the three choices falls back to `auto` — the interface's language.
 */
export function normalizeBuiltinReplyLanguage(value: unknown): BuiltinReplyLanguage {
  return value === "ru" || value === "en" ? value : DEFAULT_SETTINGS.builtinReplyLanguage;
}

/**
 * Heal the built-in agent's presets (Settings → Built-in agent): each row is a
 * named patch over the built-in knobs and registers as an agent of its own.
 * Malformed rows drop, ids dedupe and may not collide with a registered
 * adapter ({@link reserved}), and a knob that carries no number is left absent
 * — absent is what makes the preset inherit the global value.
 */
export function normalizeBuiltinPresets(
  raw: unknown,
  reserved: readonly string[] = [],
): BuiltinPresetSpec[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set(reserved);
  const out: BuiltinPresetSpec[] = [];
  for (const entry of raw) {
    if (out.length >= BUILTIN_PRESET_MAX) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const slug = normalizeCustomAgentId(row.id);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);
    const label = typeof row.label === "string" ? row.label.trim().slice(0, 80) : "";
    const thinkingLimit =
      typeof row.thinkingLimit === "number"
        ? normalizeBuiltinThinkingLimit(row.thinkingLimit)
        : undefined;
    const maxOutputTokens =
      typeof row.maxOutputTokens === "number"
        ? normalizeBuiltinMaxOutputTokens(row.maxOutputTokens)
        : undefined;
    const turnRetryAttempts =
      typeof row.turnRetryAttempts === "number"
        ? normalizeBuiltinTurnRetryAttempts(row.turnRetryAttempts)
        : undefined;
    const extraInstructions = normalizeBuiltinExtraInstructions(row.extraInstructions);
    const contextMode =
      row.contextMode === "off" || row.contextMode === "prune" || row.contextMode === "summary"
        ? row.contextMode
        : undefined;
    out.push({
      id: slug,
      label: label || slug,
      ...(thinkingLimit !== undefined ? { thinkingLimit } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(turnRetryAttempts !== undefined ? { turnRetryAttempts } : {}),
      ...(contextMode ? { contextMode } : {}),
      ...(extraInstructions ? { extraInstructions } : {}),
      ...(typeof row.allowOutsideCwd === "boolean"
        ? { allowOutsideCwd: row.allowOutsideCwd }
        : {}),
    });
  }
  return out;
}

/** Heal the trigger percent (finite number required). */
export function normalizeBuiltinCompactionThresholdPercent(value: unknown): number {
  return normalizeBoundedPercent(
    value,
    BUILTIN_COMPACTION_THRESHOLD_PERCENT_MIN,
    BUILTIN_COMPACTION_THRESHOLD_PERCENT_MAX,
    DEFAULT_SETTINGS.builtinCompactionThresholdPercent,
  );
}

/** Heal the verbatim-tail percent (finite number required). */
export function normalizeBuiltinKeepRecentPercent(value: unknown): number {
  return normalizeBoundedPercent(
    value,
    BUILTIN_KEEP_RECENT_PERCENT_MIN,
    BUILTIN_KEEP_RECENT_PERCENT_MAX,
    DEFAULT_SETTINGS.builtinKeepRecentPercent,
  );
}

/** Heal the digest ceiling; 0 is kept as "no ceiling". */
export function normalizeBuiltinMaxSummaryTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinMaxSummaryTokens;
  }
  return Math.min(BUILTIN_MAX_SUMMARY_TOKENS_MAX, Math.max(0, Math.round(value)));
}

/** Heal how many recent messages keep their `read`/`grep` output; 0 = keep all. */
export function normalizeBuiltinPruneToolResultsKeepLast(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.builtinPruneToolResultsKeepLast;
  }
  return Math.min(BUILTIN_PRUNE_TOOL_RESULTS_KEEP_LAST_MAX, Math.max(0, Math.round(value)));
}

/** Cap on the extra instructions appended to the built-in agent's prompt. */
export const BUILTIN_EXTRA_INSTRUCTIONS_MAX = 8_000;

/** Heal the appended instructions: a non-string becomes "", the rest is capped. */
export function normalizeBuiltinExtraInstructions(value: unknown): string {
  return typeof value === "string" ? value.slice(0, BUILTIN_EXTRA_INSTRUCTIONS_MAX) : "";
}

/**
 * Heal the built-in agent's context-management knobs on a merged settings
 * object. The tail is clamped below the trigger: a verbatim tail larger than
 * the line that fires the pass would leave nothing to drop, and the pass would
 * degrade to plain truncation.
 */
export function normalizeBuiltinContextSettings(settings: AppSettings): void {
  settings.builtinContextMode = normalizeBuiltinContextMode(settings.builtinContextMode);
  settings.builtinCompactionThresholdPercent = normalizeBuiltinCompactionThresholdPercent(
    settings.builtinCompactionThresholdPercent,
  );
  settings.builtinKeepRecentPercent = normalizeBuiltinKeepRecentPercent(
    settings.builtinKeepRecentPercent,
  );
  settings.builtinMaxSummaryTokens = normalizeBuiltinMaxSummaryTokens(
    settings.builtinMaxSummaryTokens,
  );
  settings.builtinPruneToolResultsKeepLast = normalizeBuiltinPruneToolResultsKeepLast(
    settings.builtinPruneToolResultsKeepLast,
  );
  settings.builtinPruneReasoning = normalizeBuiltinPruneReasoning(settings.builtinPruneReasoning);
  if (typeof settings.builtinRespectReasoningHistory !== "boolean") {
    settings.builtinRespectReasoningHistory = DEFAULT_SETTINGS.builtinRespectReasoningHistory;
  }
  settings.builtinOffloadToolResultTokens = normalizeBuiltinOffloadToolResultTokens(
    settings.builtinOffloadToolResultTokens,
  );

  settings.builtinKeepRecentPercent = Math.max(
    BUILTIN_KEEP_RECENT_PERCENT_MIN,
    Math.min(
      settings.builtinKeepRecentPercent,
      settings.builtinCompactionThresholdPercent - BUILTIN_TAIL_HEADROOM_PERCENT,
    ),
  );
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
  // Folds a pre-provider payload into `builtinProviders` and rewrites stored
  // builtin model values to their composite form.
  normalizeBuiltinProviders(merged);
  // Server-owned: a form submit carrying it must not reset the one-shot flag.
  merged.builtinEffortsSeeded = partial.builtinEffortsSeeded === true;
  merged.builtinMaxOutputTokens = normalizeBuiltinMaxOutputTokens(partial.builtinMaxOutputTokens);
  merged.builtinTurnRetryAttempts = normalizeBuiltinTurnRetryAttempts(
    partial.builtinTurnRetryAttempts,
  );
  merged.builtinThinkingLimit = normalizeBuiltinThinkingLimit(partial.builtinThinkingLimit);
  merged.builtinBashTimeoutSec = normalizeBuiltinBashTimeoutSec(partial.builtinBashTimeoutSec);
  normalizeBuiltinContextSettings(merged);
  merged.builtinReplyLanguage = normalizeBuiltinReplyLanguage(merged.builtinReplyLanguage);
  merged.chatMetaChips = normalizeChatMetaChips(partial.chatMetaChips, schemaVersion);
  merged.chatAgentTurnTimeline = normalizeChatAgentTurnTimeline(
    partial.chatAgentTurnTimeline,
    schemaVersion,
  );
  merged.chatToolbarStyle = normalizeChatToolbarStyle(partial.chatToolbarStyle);
  merged.boardAddCardStyle = normalizeBoardAddCardStyle(partial.boardAddCardStyle);
  merged.boardTaskAgentPicker = normalizeBoardTaskAgentPicker(partial.boardTaskAgentPicker);
  merged.boardTaskModelPicker = normalizeBoardTaskModelPicker(partial.boardTaskModelPicker);
  merged.boardTaskEffortPicker = normalizeBoardTaskEffortPicker(partial.boardTaskEffortPicker);
  if (typeof partial.boardShowFirstMessage !== "boolean") {
    merged.boardShowFirstMessage = DEFAULT_SETTINGS.boardShowFirstMessage;
  }
  // Anything but an explicit "server" falls back to the device default.
  merged.attachDefaultSource = partial.attachDefaultSource === "server" ? "server" : "device";
  merged.chatGitBranchPosition = normalizeChatGitBranchPosition(partial.chatGitBranchPosition);
  merged.chatTreeRecentLimit = normalizeChatTreeRecentLimit(partial.chatTreeRecentLimit);
  merged.chatTreeMenu = normalizeChatTreeMenu(partial.chatTreeMenu, schemaVersion);
  merged.chatTitleMaxLen = normalizeChatTitleMaxLen(partial.chatTitleMaxLen);
  merged.editorTheme = normalizeEditorTheme(partial.editorTheme);
  merged.editorSplit = normalizeEditorSplit(partial.editorSplit);
  merged.fileOpenTarget = normalizeFileOpenTarget(partial.fileOpenTarget);
  merged.editorNavPlacement = normalizeEditorNavPlacement(partial.editorNavPlacement);
  merged.editorKeyDefinition = normalizeEditorKeyCombo(
    partial.editorKeyDefinition,
    DEFAULT_EDITOR_KEYS.definition,
  );
  merged.editorKeyUsages = normalizeEditorKeyCombo(partial.editorKeyUsages, DEFAULT_EDITOR_KEYS.usages);
  merged.editorKeySave = normalizeEditorKeyCombo(partial.editorKeySave, DEFAULT_EDITOR_KEYS.save);
  merged.editorKeyAsk = normalizeEditorKeyCombo(partial.editorKeyAsk, DEFAULT_EDITOR_KEYS.ask);
  merged.editorKeyFormat = normalizeEditorKeyCombo(
    partial.editorKeyFormat,
    DEFAULT_EDITOR_KEYS.format,
  );
  merged.editorToolTypescript = normalizeEditorToolSource(partial.editorToolTypescript);
  merged.editorToolOxlint = normalizeEditorToolSource(partial.editorToolOxlint);
  merged.editorToolOxfmt = normalizeEditorToolSource(partial.editorToolOxfmt);
  merged.chatChipOptions = normalizeChatChipOptions(partial.chatChipOptions);
  merged.mcpProjectFiles = normalizeMcpProjectFiles(partial.mcpProjectFiles);
  merged.mcpBuiltinDisabledIds = Array.isArray(partial.mcpBuiltinDisabledIds)
    ? partial.mcpBuiltinDisabledIds.filter((id): id is string => typeof id === "string")
    : [...DEFAULT_SETTINGS.mcpBuiltinDisabledIds];
  merged.builtinSkillPaths = normalizeSkillPaths(partial.builtinSkillPaths);
  merged.builtinProjectRules = normalizeBuiltinProjectRules(partial.builtinProjectRules);
  merged.builtinIgnoreFiles = normalizeIgnoreFiles(partial.builtinIgnoreFiles);
  merged.builtinSkillModes = normalizeSkillModes(partial.builtinSkillModes);
  merged.builtinExtraInstructions = normalizeBuiltinExtraInstructions(
    partial.builtinExtraInstructions,
  );
  merged.builtinSubagents = normalizeBuiltinSubagents(partial.builtinSubagents);
  merged.builtinPresets = normalizeBuiltinPresets(partial.builtinPresets);
  if (typeof partial.builtinAllowOutsideCwd !== "boolean") {
    merged.builtinAllowOutsideCwd = DEFAULT_SETTINGS.builtinAllowOutsideCwd;
  }
  if (typeof partial.builtinMarkdownImages !== "boolean") {
    merged.builtinMarkdownImages = DEFAULT_SETTINGS.builtinMarkdownImages;
  }
  if (typeof partial.builtinPlanTool !== "boolean") {
    merged.builtinPlanTool = DEFAULT_SETTINGS.builtinPlanTool;
  }
  if (typeof partial.chatAutoTitle !== "boolean") {
    merged.chatAutoTitle = DEFAULT_SETTINGS.chatAutoTitle;
  }
  if (typeof partial.chatTitleModel !== "string") {
    merged.chatTitleModel = DEFAULT_SETTINGS.chatTitleModel;
  }
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
