/**
 * Editor preferences: shared by the code pane, the settings file and the
 * server-side heal, so a stored value means the same thing in all three.
 *
 * Key combos are kept in CodeMirror's own notation (`Mod-s`, `Shift-F12`) —
 * the pane hands the string straight to its keymap, and a hand-edited settings
 * file cannot smuggle in a combo the editor would only fail to bind.
 */

export const EDITOR_THEMES = ["auto", "light", "dark"] as const;
export type EditorThemeChoice = (typeof EDITOR_THEMES)[number];

/** Where the code pane sits when it shares the screen with the chat. */
export const EDITOR_SPLITS = ["off", "left", "right"] as const;
export type EditorSplit = (typeof EDITOR_SPLITS)[number];

/**
 * Which copy of a tool the pane runs: the project's own (`auto` prefers it and
 * falls back to the bundled one), explicitly the project's, or explicitly ours.
 */
export const EDITOR_TOOLS = ["typescript", "oxlint", "oxfmt"] as const;
export type EditorTool = (typeof EDITOR_TOOLS)[number];

export const EDITOR_TOOL_SOURCES = ["auto", "project", "bundled"] as const;
export type EditorToolSource = (typeof EDITOR_TOOL_SOURCES)[number];

export const DEFAULT_EDITOR_TOOL_SOURCE: EditorToolSource = "auto";

export function normalizeEditorToolSource(raw: unknown): EditorToolSource {
  return EDITOR_TOOL_SOURCES.includes(raw as EditorToolSource)
    ? (raw as EditorToolSource)
    : DEFAULT_EDITOR_TOOL_SOURCE;
}

export const EDITOR_KEY_ACTIONS = ["definition", "usages", "save", "ask", "format"] as const;
export type EditorKeyAction = (typeof EDITOR_KEY_ACTIONS)[number];

export const DEFAULT_EDITOR_THEME: EditorThemeChoice = "auto";

export const DEFAULT_EDITOR_KEYS: Record<EditorKeyAction, string> = {
  definition: "F12",
  usages: "Shift-F12",
  save: "Mod-s",
  ask: "Mod-k",
  format: "Shift-Alt-f",
};

const MODIFIERS = new Set(["Mod", "Ctrl", "Cmd", "Alt", "Shift"]);
const KEY_NAMES =
  /^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Esc|Enter|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown)$/;

/** One combo, no alternatives: `Mod-s`, `Ctrl-Shift-d`, `F12`, `Shift-F12`. */
export function isEditorKeyCombo(raw: string): boolean {
  const parts = raw.trim().split("-");
  const key = parts.pop() ?? "";
  if (!KEY_NAMES.test(key)) return false;
  if (new Set(parts).size !== parts.length) return false;
  return parts.every((part) => MODIFIERS.has(part));
}

export function normalizeEditorKeyCombo(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return isEditorKeyCombo(trimmed) ? trimmed : fallback;
}

export function normalizeEditorTheme(raw: unknown): EditorThemeChoice {
  return EDITOR_THEMES.includes(raw as EditorThemeChoice)
    ? (raw as EditorThemeChoice)
    : DEFAULT_EDITOR_THEME;
}

export function normalizeEditorSplit(raw: unknown): EditorSplit {
  return EDITOR_SPLITS.includes(raw as EditorSplit) ? (raw as EditorSplit) : "off";
}

