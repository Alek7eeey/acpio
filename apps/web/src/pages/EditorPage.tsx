import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type Line,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  type DecorationSet,
  WidgetType,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  canonicalCwd,
  isEditorKeyCombo,
  type AppSettings,
  type EditorNavPlacement,
  type EditorSplit,
  type EditorThemeChoice,
  type EditorToolSource,
} from "@acpio/shared";
import { api } from "../lib/api";
import { editorApi, type EditorEntry, type LintItem, type ToolStatus } from "../lib/editorApi";
import { toolsForPath } from "../lib/editorTools";
import { dropBuffer, loadBuffers, requestPersistence, saveBuffer } from "../lib/editorStore";
import { editorTheme, type EditorScheme } from "../lib/editorTheme";
import { NavHistory, trapBrowserBack } from "../lib/editorNav";
import { TsLsp, languageIdOf, uriToRelPath, type LspLocation } from "../lib/tsLsp";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import type { GitChangedFileDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { showToast } from "../lib/toast";
import { useOutsidePointerClose } from "../lib/useOutsidePointerClose";
import styles from "./EditorPage.module.css";

// shortcut: spike copy is hardcoded; move it into @acpio/i18n if the pane stays.
const ASK_PLACEHOLDER = "Спросить про эту строку…";

type EditorKeys = { definition: string; usages: string; save: string; ask: string; format: string };

/** Which settings key each action is stored under. */
const KEY_SETTING = {
  definition: "editorKeyDefinition",
  usages: "editorKeyUsages",
  save: "editorKeySave",
  ask: "editorKeyAsk",
  format: "editorKeyFormat",
} as const;

const KEY_LABELS: Record<keyof EditorKeys, string> = {
  definition: "К определению",
  usages: "Использования",
  save: "Сохранить файл",
  ask: "Спросить про строку",
  format: "Форматировать файл",
};

const setAsk = StateEffect.define<number | null>();

/** The theme and the keymap are reconfigurable: both are settings, not code. */
const themeSlot = new Compartment();
const keysSlot = new Compartment();

type AskHandlers = {
  submit: (pos: number, question: string) => void;
  cancel: () => void;
};

/**
 * The inline "question about this line" field. A block widget, so it opens as a
 * full-width row *under* the line instead of squeezing in at the end of it.
 */
class AskWidget extends WidgetType {
  constructor(
    private readonly pos: number,
    private readonly handlers: AskHandlers,
  ) {
    super();
  }

  eq() {
    return false;
  }

  /** The field owns its keystrokes: CodeMirror must not act on them. */
  ignoreEvent() {
    return true;
  }

  toDOM() {
    const box = document.createElement("div");
    box.className = "cm-askBox";
    const input = document.createElement("input");
    input.className = "cm-askInput";
    input.placeholder = ASK_PLACEHOLDER;
    input.setAttribute("aria-label", ASK_PLACEHOLDER);
    const send = () => {
      const question = input.value.trim();
      if (question) this.handlers.submit(this.pos, question);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        send();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.handlers.cancel();
      }
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-askSend";
    button.textContent = "→";
    button.title = "Отправить в чат";
    button.addEventListener("click", send);
    box.append(input, button);
    setTimeout(() => input.focus(), 0);
    return box;
  }
}

function askField(handlers: AskHandlers) {
  return StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects) if (effect.is(setAsk)) return effect.value;
      return tr.docChanged ? null : value;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (pos) => {
        if (pos == null) return Decoration.none;
        const widget = new AskWidget(pos, handlers);
        return Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(pos)]);
      }),
  });
}

class AskGutterMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-askGutterButton";
    dot.textContent = "✦";
    dot.title = "Спросить про строку";
    return dot;
  }
}

const askMarker = new AskGutterMarker();

/** A clickable mark on the cursor's line — the cheapest "act on this line" affordance. */
function askGutter(open: (pos: number) => void) {
  return gutter({
    class: "cm-askGutter",
    markers: (view) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      return RangeSet.of([{ from: line.from, to: line.from, value: askMarker }], true);
    },
    domEventHandlers: {
      mousedown(view, line) {
        open(line.to);
        return true;
      },
    },
  });
}

/** `up`: `y` counts from the bottom — the menu opens above the status bar. */
type MenuRequest = { x: number; y: number; pos: number; up?: boolean };

/** Держать в согласии с `.menu { min-width }`: по ней меню сдвигается от края. */
const MENU_MIN_WIDTH = 230;

/** Держать в согласии с `.popover { width }`: по ней панель прижимается к кнопке. */
const PANEL_WIDTH = 300;

/** Где встать поповеру настроек: над кнопкой, а не у правого края окна. */
type PanelPlacement = { left: number; bottom: number; maxHeight: number };

/** A file and its diff are two tabs over one document, as in VS Code. */
type EditorTab = { path: string; kind: "file" | "diff"; pinned: boolean };

/** VS Code offers the same two: changes side by side, or in one column. */
type DiffMode = "split" | "inline";
const DIFF_MODE_KEY = "acpio.diffMode.v1";

/** Absolute path as the OS writes it, taken from the pane root. */
const absOf = (root: string, path: string) => `${root.replace(/[\\/]+$/, "")}/${path}`;

async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label} скопирован`, { tone: "info" });
  } catch {
    showToast("Не удалось скопировать — браузер закрыл буфер обмена", { tone: "danger" });
  }
}

/** The tabs of one folder: small, and needed on the first paint, so localStorage. */
type EditorWorkspace = {
  tabs: EditorTab[];
  active: string | null;
  /** Caret per file, so a reload comes back where the reader left it. */
  carets?: Record<string, { line: number; col: number }>;
  /** Unsaved text written by an older build straight into localStorage. */
  buffers?: Record<string, string>;
};
const workspaceKey = (root: string) => `acpio.editor.workspace.v1:${normPath(root)}`;

/** Entries pinned to the top of the file tree, per folder: `["web", "src"]`. */
const pinsKey = (root: string) => `acpio.editor.pins.v1:${normPath(root)}`;

/** Folders left open in the tree, per folder: `["web", "web/src"]`. */
const treeOpenKey = (root: string) => `acpio.editor.treeOpen.v1:${normPath(root)}`;

function readTreeOpen(root: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(treeOpenKey(root)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeTreeOpen(root: string, paths: string[]): void {
  try {
    localStorage.setItem(treeOpenKey(root), JSON.stringify(paths));
  } catch {
    // A full quota only costs the open folders; the tree still works.
  }
}

/** «Изменения» показываются деревом папок или плоским списком путей. */
type ChangeView = "tree" | "list";
const CHANGE_VIEW_KEY = "acpio.editor.changeView.v1";

function readChangeView(): ChangeView {
  if (typeof window === "undefined") return "tree";
  return localStorage.getItem(CHANGE_VIEW_KEY) === "list" ? "list" : "tree";
}

const TREE_WIDTH_KEY = "acpio.editor.treeWidth.v1";
const TREE_HIDDEN_KEY = "acpio.editor.treeHidden.v1";
const TREE_MIN = 150;
const TREE_DEFAULT = 260;
const TREE_MAX = 700;

function readTreeWidth(): number {
  if (typeof window === "undefined") return TREE_DEFAULT;
  const raw = Number(localStorage.getItem(TREE_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= TREE_MIN ? Math.min(TREE_MAX, raw) : TREE_DEFAULT;
}

function readPins(root: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(pinsKey(root)) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

// Exported for their own test: the shape a reload reads back.
export function readWorkspace(root: string): EditorWorkspace | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(workspaceKey(root)) ?? "null",
    ) as Partial<EditorWorkspace> | null;
    if (!parsed) return null;
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : []).filter(
      (tab): tab is EditorTab =>
        typeof tab?.path === "string" && (tab.kind === "file" || tab.kind === "diff"),
    );
    const carets: Record<string, { line: number; col: number }> = {};
    for (const [path, at] of Object.entries(parsed.carets ?? {})) {
      const line = Number(at?.line);
      const col = Number(at?.col);
      if (Number.isFinite(line) && Number.isFinite(col)) carets[path] = { line, col };
    }
    return {
      tabs,
      active: typeof parsed.active === "string" ? parsed.active : null,
      carets,
      buffers:
        parsed.buffers && typeof parsed.buffers === "object"
          ? (parsed.buffers as Record<string, string>)
          : undefined,
    };
  } catch {
    return null;
  }
}

export function writeWorkspace(
  root: string,
  tabs: EditorTab[],
  active: string | null,
  carets?: Record<string, { line: number; col: number }>,
): void {
  try {
    localStorage.setItem(workspaceKey(root), JSON.stringify({ tabs, active, carets }));
  } catch {
    // A full quota must not break editing: the pane still works, the reload forgets.
  }
}

const tabKey = (tab: EditorTab) => `${tab.kind}:${tab.path}`;
const tabTitle = (tab: EditorTab) => tab.path.split("/").pop() ?? tab.path;

const normPath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

/**
 * git talks repo-relative paths, the pane talks paths relative to its own root,
 * and the two roots are not always the same folder (a repo opened one level up,
 * or a workspace member inside it). These two translate between them, and
 * `null` means the file is not reachable from this pane.
 */
function paneToRepo(repoRoot: string, paneRoot: string, path: string): string {
  const repo = normPath(repoRoot);
  const pane = normPath(paneRoot);
  if (repo === pane) return path;
  if (repo.startsWith(`${pane}/`)) return `${repo.slice(pane.length + 1)}/${path}`;
  if (pane.startsWith(`${repo}/`)) return `${pane.slice(repo.length + 1)}/${path}`;
  return path;
}

function repoToPane(repoRoot: string, paneRoot: string, path: string): string | null {
  const repo = normPath(repoRoot);
  const pane = normPath(paneRoot);
  if (repo === pane) return path;
  if (repo.startsWith(`${pane}/`)) return `${repo.slice(pane.length + 1)}/${path}`;
  if (pane.startsWith(`${repo}/`)) {
    const prefix = `${pane.slice(repo.length + 1)}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
  }
  return path;
}

const TOOL_SOURCE_LABEL = {
  project: "проект",
  bundled: "встроенный",
  missing: "не настроен",
} as const;
const TOOL_SHORT = { typescript: "ts", oxlint: "oxlint", oxfmt: "oxfmt" } as const;
const SOURCE_CLASS = {
  project: styles.dotProject,
  bundled: styles.dotBundled,
  missing: styles.dotMissing,
} as const;

/** Status-bar wording: errors first, warnings only when there are no errors. */
function problemCountLabel(problems: Problem[]): string {
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  if (errors && warnings) return `${errors}\u00d7 \u26a0${warnings}`;
  return errors ? `\u00d7${errors}` : `\u26a0${warnings}`;
}

/** git's letter for a path, coloured by what it means. */
function letterClass(letter: string): string {
  if (letter === "A" || letter === "?") return styles.badgeAdded;
  if (letter === "D") return styles.badgeDeleted;
  if (letter === "U") return styles.badgeConflict;
  return styles.badgeModified;
}

/** One row of the problems panel: TS, oxlint or anything else that spoke. */
type Problem = {
  path: string;
  line: number;
  col: number;
  message: string;
  severity: LintItem["severity"];
  source: string;
};

type EditorHandlers = {
  goto: () => void;
  usages: () => void;
  save: () => void;
  format: () => void;
  ask: (pos: number) => void;
  menu: (request: MenuRequest) => void;
};

/**
 * Two gestures CodeMirror leaves to the host: `Mod`-click goes to the definition
 * (the one thing every editor user tries first), and the right button opens our
 * own menu — the default browser menu has nothing to say about a symbol.
 */
/** The symbol (or import path) Ctrl currently points at. */
const setLink = StateEffect.define<{ from: number; to: number } | null>();

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setLink)) {
        next = effect.value
          ? Decoration.set([
              Decoration.mark({ class: "cm-ctrlLink" }).range(effect.value.from, effect.value.to),
            ])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const WORD_CHAR = /[\w$]/;

/** The quoted string the offset sits in — `null` when it sits in none. */
function stringRangeAt(
  line: Line,
  offset: number,
): { from: number; to: number; text: string } | null {
  const pattern = /(["'`])([^"'`]*)\1/g;
  for (let match = pattern.exec(line.text); match; match = pattern.exec(line.text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (offset >= from && offset < to) {
      return { from: line.from + from, to: line.from + to, text: match[2] };
    }
  }
  return null;
}

/**
 * What a Ctrl+click would jump to: the identifier under the pointer, or the string
 * that holds an import path. Anything else is not a link, as in VS Code.
 */
function linkRangeAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const offset = pos - line.from;
  const string = stringRangeAt(line, offset);
  if (string) return { from: string.from, to: string.to };
  if (!WORD_CHAR.test(text[offset] ?? "")) return null;
  let start = offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  let end = offset;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  return { from: line.from + start, to: line.from + end };
}

/** The import specifier the caret sits in, if it sits in one. */
function importSpecAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  return stringRangeAt(line, pos - line.from)?.text ?? null;
}

/** The identifier the caret sits in — `serviceDef` in `… = serviceDef<T>(…)`. */
function wordAt(text: string, offset: number): string {
  const isWord = (char: string | undefined) => Boolean(char && /[\w$]/.test(char));
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(text[from - 1])) from -= 1;
  while (to < text.length && isWord(text[to])) to += 1;
  return text.slice(from, to);
}

/** The module specifier that brings `name` into a document, if any import does. */
function specForName(text: string, name: string): string | null {
  const word = new RegExp(`\\b${name}\\b`);
  for (const line of text.split("\n")) {
    if (!/^\s*(import|export)\b/.test(line)) continue;
    const spec = /from\s*["']([^"']+)["']/.exec(line)?.[1];
    if (spec && word.test(line)) return spec;
  }
  return null;
}

/** Ctrl held or released without moving the mouse: the underline follows it. */
export function syncLink(view: EditorView, point: { x: number; y: number } | null) {
  if (!point) {
    if (view.state.field(linkField, false)) view.dispatch({ effects: setLink.of(null) });
    return;
  }
  const pos = view.posAtCoords(point);
  const range = pos == null ? null : linkRangeAt(view, pos);
  const current = view.state.field(linkField, false);
  const existing = current && current.size > 0 ? current.iter(0) : null;
  if (!range) {
    if (current) view.dispatch({ effects: setLink.of(null) });
    return;
  }
  if (existing && existing.from === range.from && existing.to === range.to) return;
  view.dispatch({ effects: setLink.of(range) });
}

/** Last pointer position per view: a Ctrl press alone has to underline too. */
const hoverPoint = new WeakMap<EditorView, { x: number; y: number }>();

function pointerExtensions(handlers: { current: EditorHandlers }) {
  return [
    linkField,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        hoverPoint.set(view, { x: event.clientX, y: event.clientY });
        if (event.ctrlKey || event.metaKey) syncLink(view, hoverPoint.get(view) ?? null);
        else if (view.state.field(linkField, false)) syncLink(view, null);
        return false;
      },
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos } });
        handlers.current.goto();
        return true;
      },
      contextmenu(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        event.preventDefault();
        if (pos != null) view.dispatch({ selection: { anchor: pos } });
        handlers.current.menu({
          x: event.clientX,
          y: event.clientY,
          pos: pos ?? view.state.selection.main.head,
        });
        return true;
      },
    }),
  ];
}

export { hoverPoint };

/**
 * Languages that are loaded on demand: a pane that opens no YAML should not ship
 * a YAML parser. A document is created without them and gets the extension in
 * its state before the tab appears (`ensureDocument` primes the cache first).
 */
const lazyLanguage: Record<string, () => Promise<Extension>> = {
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsonc: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  htm: async () => (await import("@codemirror/lang-html")).html(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
};

/** Extension loaded so far, keyed by file path. */
const languageCache = new Map<string, Extension>();

/** Load a lazy language before its document is built. */
async function primeLanguage(path: string) {
  if (languageCache.has(path)) return;
  const ext = lazyLanguage[extensionOf(path)];
  if (ext === undefined) return;
  try {
    languageCache.set(path, await ext());
  } catch {
    // A chunk that will not load costs highlighting, not the file.
    languageCache.set(path, []);
  }
}

function extensionOf(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function languageFor(path: string) {
  const ext = extensionOf(path);
  const cached = languageCache.get(path);
  if (cached) return cached;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    return javascript({ typescript: ext.startsWith("ts"), jsx: ext === "tsx" || ext === "jsx" });
  }
  // SCSS has no CM6 parser of its own; the CM5 mode beats plain text.
  if (ext === "scss" || ext === "sass") return StreamLanguage.define(sass);
  if (ext === "cs") return StreamLanguage.define(csharp);
  return [];
}

function toDiagnostic(view: EditorView, item: LintItem): Diagnostic | null {
  if (item.line > view.state.doc.lines) return null;
  const startLine = view.state.doc.line(Math.max(1, item.line));
  const from = Math.min(startLine.to, startLine.from + Math.max(0, item.col - 1));
  const endLine = view.state.doc.line(
    Math.min(view.state.doc.lines, Math.max(item.line, item.endLine)),
  );
  const to = Math.min(endLine.to, endLine.from + Math.max(0, item.endCol - 1));
  return {
    from,
    to: Math.max(to, from),
    severity: item.severity,
    message: item.message,
    source: item.source,
  };
}

/**
 * One pane, one folder. A caller that keeps an instance per folder passes both
 * props; on its own the page follows the selected session.
 */
export function EditorPage({
  root: rootProp,
  sessionId: sessionProp,
  chatHidden,
  onToggleChat,
  active = true,
}: {
  root?: string;
  sessionId?: string | null;
  /** The chat is put away: the button offers to bring it back. */
  chatHidden?: boolean;
  onToggleChat?: () => void;
  /**
   * The pane on screen. A folder's pane stays mounted while another is shown,
   * and only the visible one may take the browser's back button: two traps on
   * one press would each walk their own history.
   */
  active?: boolean;
} = {}) {
  const storeRoot = useAppStore((s) => s.activeSession?.cwd ?? s.knownFolders[0] ?? "");
  const storeSession = useAppStore((s) => s.activeSessionId);
  const root = rootProp ?? storeRoot;
  const sessionId = sessionProp ?? storeSession;
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  // A file clicked in the chat (see lib/fileOpen.ts) waits here until this pane,
  // the one whose folder holds it, is on screen.
  const revealRequest = useAppStore((s) => s.editorReveal);
  const consumeEditorReveal = useAppStore((s) => s.consumeEditorReveal);

  const scheme: EditorScheme =
    settings.editorTheme === "auto"
      ? settings.theme === "dark"
        ? "dark"
        : "light"
      : settings.editorTheme;

  const keys = useMemo<EditorKeys>(
    () => ({
      definition: settings.editorKeyDefinition,
      usages: settings.editorKeyUsages,
      save: settings.editorKeySave,
      ask: settings.editorKeyAsk,
      format: settings.editorKeyFormat,
    }),
    [
      settings.editorKeyAsk,
      settings.editorKeyDefinition,
      settings.editorKeyFormat,
      settings.editorKeySave,
      settings.editorKeyUsages,
    ],
  );

  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** Unsaved text read back from the last session, used instead of the file. */
  const restoreBuffers = useRef(new Map<string, string>());
  const restoredFor = useRef<string | null>(null);
  /** What each file's stored buffer holds, so a keystroke writes only its own. */
  const persistedRef = useRef(new Map<string, string>());
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [refs, setRefs] = useState<LspLocation[]>([]);
  const [status, setStatus] = useState("");
  /** A jump is in flight: the bar says so instead of looking frozen. */
  const [busy, setBusy] = useState<null | "definition" | "usages">(null);
  const [treeWidth, setTreeWidth] = useState(readTreeWidth);
  const [treeHidden, setTreeHidden] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(TREE_HIDDEN_KEY) === "1",
  );

  useEffect(() => {
    localStorage.setItem(TREE_HIDDEN_KEY, treeHidden ? "1" : "0");
  }, [treeHidden]);
  const [treeDragging, setTreeDragging] = useState(false);
  const treeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
  }, [treeWidth]);

  const onTreeSplitterDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      treeDragRef.current = { startX: event.clientX, startWidth: treeWidth };
      setTreeDragging(true);
    },
    [treeWidth],
  );

  useEffect(() => {
    if (!treeDragging) return;
    const onMove = (event: PointerEvent) => {
      const drag = treeDragRef.current;
      if (!drag) return;
      setTreeWidth(
        Math.min(TREE_MAX, Math.max(TREE_MIN, drag.startWidth + event.clientX - drag.startX)),
      );
    };
    const onUp = () => {
      treeDragRef.current = null;
      setTreeDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [treeDragging]);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Привязка считается в момент нажатия: панель висит там, где кнопка, а не
  // у правого края окна — панель редактора бывает узкой и стоит слева от чата.
  const [panelPlacement, setPanelPlacement] = useState<PanelPlacement | null>(null);
  const [treeTab, setTreeTab] = useState<"files" | "changes">("files");
  const [changeView, setChangeView] = useState<ChangeView>(readChangeView);

  useEffect(() => {
    localStorage.setItem(CHANGE_VIEW_KEY, changeView);
  }, [changeView]);
  const [changes, setChanges] = useState<{
    repo: boolean;
    root: string;
    files: GitChangedFileDto[];
  } | null>(null);
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: EditorTab } | null>(null);
  // A request to show a path in the tree: `seq` makes a repeated request act.
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const revealSeq = useRef(0);
  /** Revision content of every open diff tab, fetched when the tab opens. */
  const diffBaseRef = useRef<Map<string, string>>(new Map());
  const [problems, setProblems] = useState<Problem[]>([]);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [tools, setTools] = useState<{
    tools: Record<"typescript" | "oxlint" | "oxfmt", ToolStatus>;
    project: string;
  } | null>(null);
  const [draftKeys, setDraftKeys] = useState<EditorKeys>(keys);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const statesRef = useRef(new Map<string, EditorState>());
  const lspRef = useRef<TsLsp | null>(null);
  /** The tab view; `viewRef` points at the merge view's editable side while a diff is open. */
  const mainViewRef = useRef<EditorView | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const mergeHostRef = useRef<HTMLDivElement | null>(null);
  /** Diff layout: two columns like VS Code's split view, or one unified column. */
  const [diffMode, setDiffMode] = useState<DiffMode>(() =>
    localStorage.getItem(DIFF_MODE_KEY) === "inline" ? "inline" : "split",
  );

  useEffect(() => {
    localStorage.setItem(DIFF_MODE_KEY, diffMode);
  }, [diffMode]);

  // The pane list on the tasks page shows how much each editor holds open.
  const setEditorTabs = useAppStore((s) => s.setEditorTabs);
  useEffect(() => {
    setEditorTabs(root, tabs.length);
  }, [root, setEditorTabs, tabs.length]);

  const activeTab = tabs.find((tab) => tabKey(tab) === activeKey) ?? null;
  const activePath = activeTab?.path ?? null;
  const diffPath = activeTab?.kind === "diff" ? activeTab.path : null;
  const diff = useMemo(
    () => (diffPath ? { path: diffPath, base: diffBaseRef.current.get(diffPath) ?? "" } : null),
    [diffPath],
  );

  /** Give the document back to the tab view, with whatever the user did in the diff. */
  const closeDiff = useCallback(() => {
    const merge = mergeRef.current;
    const main = mainViewRef.current;
    if (merge && main) main.setState(merge.b.state);
    requestAnimationFrame(() => main?.requestMeasure());
  }, []);
  const oxlintRef = useRef(new Map<string, LintItem[]>());
  const lspDiagsRef = useRef(new Map<string, LintItem[]>());
  const activeRef = useRef<string | null>(null);
  // Where the reader was in each file: a reload puts the caret back there.
  const caretsRef = useRef(new Map<string, { line: number; col: number }>());
  const rememberCaret = useCallback(() => {
    const view = viewRef.current;
    const path = activeRef.current;
    // The merge view has its own document and its own line numbers.
    if (!view || !path || view !== mainViewRef.current) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    caretsRef.current.set(path, { line: line.number, col: head - line.from + 1 });
  }, []);
  const caretsOf = useCallback(
    () => Object.fromEntries(caretsRef.current) as Record<string, { line: number; col: number }>,
    [],
  );
  /** Where «назад» comes back to: the places the pane has been, with the caret. */
  const navRef = useRef(new NavHistory());
  /** Set while the history itself is being walked: that move is not a new step. */
  const navApplying = useRef(false);
  /** Whether the arrows can act; the history itself stays in a ref. */
  const [navFlags, setNavFlags] = useState({ back: false, forward: false });
  const syncNavFlags = useCallback(() => {
    setNavFlags({ back: navRef.current.canBack, forward: navRef.current.canForward });
  }, []);
  const rootRef = useRef(root);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const sessionRef = useRef<string | null>(sessionId);
  const lintTimer = useRef<number>(0);
  const syncTimer = useRef<number>(0);
  rootRef.current = root;
  sessionRef.current = sessionId;

  useEffect(() => setDraftKeys(keys), [keys]);

  const relOf = useCallback((uri: string) => {
    const rel = uriToRelPath(rootRef.current, uri);
    return rel && rel.length > 0 ? rel : null;
  }, []);

  /** Every finding we hold, per file — the panel behind the counter. */
  const refreshProblems = useCallback(() => {
    const list: Problem[] = [];
    for (const path of new Set([...oxlintRef.current.keys(), ...lspDiagsRef.current.keys()])) {
      const items = [
        ...(oxlintRef.current.get(path) ?? []),
        ...(lspDiagsRef.current.get(path) ?? []),
      ];
      for (const item of items) {
        list.push({
          path,
          line: item.line,
          col: item.col,
          message: item.message,
          severity: item.severity,
          source: item.source,
        });
      }
    }
    list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.col - b.col);
    setProblems(list);
  }, []);

  /**
   * Our diagnostics come from the language server and oxlint, not from a lint
   * source inside CodeMirror: `forceLinting` only re-runs a *scheduled* linter
   * (it is a no-op once the first pass has finished), so the results are pushed
   * into the editor with `setDiagnostics` instead.
   */
  const applyDiagnostics = useCallback(
    (path: string) => {
      refreshProblems();
      const view = viewRef.current;
      if (!view || activeRef.current !== path) return;
      const items = [
        ...(oxlintRef.current.get(path) ?? []),
        ...(lspDiagsRef.current.get(path) ?? []),
      ];
      const diagnostics: Diagnostic[] = [];
      for (const item of items) {
        const diagnostic = toDiagnostic(view, item);
        if (diagnostic) diagnostics.push(diagnostic);
      }
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
    [refreshProblems],
  );

  const sendQuestion = useCallback(async (path: string, line: number, question: string) => {
    const id = sessionRef.current;
    if (!id) {
      showToast("Нет активной сессии — вопрос некуда отправить", { tone: "danger" });
      return;
    }
    try {
      await api.prompt(id, `${question}\n\n${path}:${line}`, {});
      showToast("Вопрос отправлен в чат", { tone: "success" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Не удалось отправить вопрос", {
        tone: "danger",
      });
    }
  }, []);

  const cmKeys = useCallback(
    (k: EditorKeys) =>
      keymap.of([
        {
          key: k.ask,
          run: (view) => {
            const line = view.state.doc.lineAt(view.state.selection.main.head);
            view.dispatch({ effects: setAsk.of(line.to) });
            return true;
          },
        },
        { key: k.definition, run: () => (handlersRef.current.goto(), true) },
        { key: k.usages, run: () => (handlersRef.current.usages(), true) },
        { key: k.save, run: () => (handlersRef.current.save(), true) },
        { key: k.format, run: () => (handlersRef.current.format(), true) },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    [],
  );

  /**
   * Ctrl+Space only: the pane asks tsserver when the user asks it to, so no
   * keystroke ever waits on a language server. `completionKeymap` (Arrow/Enter/
   * Escape) comes with `autocompletion` itself, at highest precedence.
   *
   * Only files the TypeScript server holds get hints: a CSS or YAML document is
   * never handed to it, and asking anyway would be a round trip for nothing.
   */
  const lspCompletion = useCallback(
    (path: string) => async (context: CompletionContext): Promise<CompletionResult | null> => {
      const lsp = lspRef.current;
      if (!lsp || !languageIdOf(path)) return null;
      const line = context.state.doc.lineAt(context.pos);
      // The buffer reaches tsserver on a 400ms timer; a press inside that window
      // would ask about text the server has not seen yet.
      lsp.change(path, context.state.doc.toString());
      const items = await lsp.completion(path, line.number - 1, context.pos - line.from);
      if (items.length === 0) return null;
      // tsserver filtered on the prefix already; the range lets the popup keep
      // narrowing the list locally while the user types. `validFor` is what keeps
      // that local: without it every keystroke would ask the server again.
      const word = context.matchBefore(/[\w$]+/);
      return {
        from: word ? word.from : context.pos,
        options: items,
        validFor: /^[\w$]*$/,
      };
    },
    [],
  );

  const handlersRef = useRef<EditorHandlers>({
    goto: () => {},
    usages: () => {},
    save: () => {},
    format: () => {},
    ask: () => {},
    menu: () => {},
  });

  /** Push the current theme/keys into a view without rebuilding its state. */
  const applyEditorConfig = useCallback(
    (view: EditorView) => {
      view.dispatch({
        effects: [themeSlot.reconfigure(editorTheme(scheme)), keysSlot.reconfigure(cmKeys(keys))],
      });
    },
    [cmKeys, keys, scheme],
  );

  /** Everything a document of this pane carries, minus its text. */
  const docExtensions = useCallback(
    (path: string, rootPath: string) => {
      const handlers: AskHandlers = {
        submit: (pos, question) => {
          const view = viewRef.current;
          if (!view) return;
          const line = view.state.doc.lineAt(pos).number;
          view.dispatch({ effects: setAsk.of(null) });
          void sendQuestion(path, line, question);
        },
        cancel: () => viewRef.current?.dispatch({ effects: setAsk.of(null) }),
      };
      return [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        languageFor(path),
        lintGutter(),
        autocompletion({ activateOnTyping: false, override: [lspCompletion(path)] }),
        askField(handlers),
        askGutter((pos) => viewRef.current?.dispatch({ effects: setAsk.of(pos) })),
        pointerExtensions(handlersRef),
        themeSlot.of(editorTheme(scheme)),
        keysSlot.of(cmKeys(keys)),
        EditorView.updateListener.of((update) => {
          const current = activeRef.current;
          if (!current) return;
          if (update.docChanged) {
            statesRef.current.set(current, update.state);
            setDirty((prev) => (prev.has(current) ? prev : new Set(prev).add(current)));
            const next = update.state.doc.toString();
            window.clearTimeout(syncTimer.current);
            syncTimer.current = window.setTimeout(() => lspRef.current?.change(current, next), 400);
            window.clearTimeout(lintTimer.current);
            lintTimer.current = window.setTimeout(() => {
              void editorApi.lint(rootPath, current).then(
                ({ items, note }) => {
                  oxlintRef.current.set(current, items);
                  applyDiagnostics(current);
                  // No oxlint in this project: say so once, not per keystroke.
                  if (note) setStatus(note);
                },
                () => {},
              );
            }, 700);
          } else if (update.selectionSet) {
            statesRef.current.set(current, update.state);
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            setCursorPos({ line: line.number, col: head - line.from + 1 });
          }
        }),
      ];
    },
    [applyDiagnostics, cmKeys, keys, lspCompletion, scheme, sendQuestion],
  );

  const makeState = useCallback(
    (path: string, text: string, rootPath: string) =>
      EditorState.create({ doc: text, extensions: docExtensions(path, rootPath) }),
    [docExtensions],
  );

  /**
   * Everything a plain open does to the document — read it, give it and its
   * imports to the language server, lint it. Tabs only decide what shows it.
   */
  const ensureDocument = useCallback(
    async (path: string) => {
      const rootPath = rootRef.current;
      if (!rootPath) return false;
      if (statesRef.current.has(path)) return true;
      // A buffer the reload interrupted opens with what the user had typed.
      const unsaved = restoreBuffers.current.get(path);
      if (unsaved != null) {
        restoreBuffers.current.delete(path);
        await primeLanguage(path);
        statesRef.current.set(path, makeState(path, unsaved, rootPath));
        lspRef.current?.open(path, unsaved);
        setDirty((prev) => new Set(prev).add(path));
        return true;
      }
      try {
        // Before the state exists: highlighting must be there on the first paint.
        await primeLanguage(path);
        const file = await editorApi.file(rootPath, path);
        statesRef.current.set(path, makeState(path, file.text, rootPath));
        lspRef.current?.open(path, file.text);
        // The server knows only what it was handed: its imports go with it, so a
        // jump into another file lands on the declaration instead of the import.
        void editorApi.imports(rootPath, path).then(
          (paths) => void lspRef.current?.preload(paths),
          () => {},
        );
        // Lint on open too: the panel is useless if it fills only on a keystroke.
        if (!oxlintRef.current.has(path)) {
          void editorApi.lint(rootPath, path).then(
            ({ items, note }) => {
              oxlintRef.current.set(path, items);
              applyDiagnostics(path);
              if (note) setStatus(note);
            },
            () => {},
          );
        }
        return true;
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Не удалось открыть файл", {
          tone: "danger",
        });
        return false;
      }
    },
    [applyDiagnostics, makeState],
  );

  /** Put a tab in front. `line`/`col` only make sense for a file tab. */
  const activateTab = useCallback(
    (tab: EditorTab, line?: number, col?: number) => {
      rememberCaret();
      if (navApplying.current) {
        // A move made by «назад»/«вперёд» is already a step of its own.
        navApplying.current = false;
      } else {
        const key = tabKey(tab);
        const cur = navRef.current.current;
        const caret = caretsRef.current.get(tab.path);
        // A jump inside one file remembers where the reader stood, so «назад»
        // comes back to that line instead of to wherever the file was opened.
        if (cur && caret && cur.key === key && activeRef.current === tab.path) {
          navRef.current.push({ key, line: caret.line, col: caret.col });
        }
        const at = line != null ? { line, col: col ?? 1 } : caret;
        navRef.current.push({ key, line: at?.line ?? 1, col: at?.col ?? 1 });
        syncNavFlags();
      }
      // A diff owns the visible area: switching files leaves it. And the state
      // goes to the tab view — `viewRef` may still point at the merge view.
      if (tab.kind === "file" && diff) closeDiff();
      activeRef.current = tab.path;
      setActiveKey(tabKey(tab));
      applyDiagnostics(tab.path);
      if (tab.kind !== "file") return;
      const view = mainViewRef.current ?? viewRef.current;
      const state = statesRef.current.get(tab.path);
      if (!view || !state) return;
      view.setState(state);
      applyEditorConfig(view);
      // A jump says where to go; a restored or revisited tab goes back to its caret.
      const at = line != null ? { line, col: col ?? 1 } : caretsRef.current.get(tab.path);
      if (at) {
        const doc = view.state.doc;
        const target = doc.line(Math.min(at.line, doc.lines));
        const pos = Math.min(target.to, target.from + Math.max(0, (at.col ?? 1) - 1));
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        // setState swaps the document without an update event: the bar must be told.
        setCursorPos({ line: target.number, col: pos - target.from + 1 });
      }
      view.focus();
    },
    [applyDiagnostics, applyEditorConfig, closeDiff, diff, rememberCaret, syncNavFlags],
  );

  const addTab = useCallback((tab: EditorTab) => {
    setTabs((prev) => (prev.some((t) => tabKey(t) === tabKey(tab)) ? prev : [...prev, tab]));
  }, []);
  const openFile = useCallback(
    async (path: string, line?: number, col?: number) => {
      if (!(await ensureDocument(path))) return;
      const tab = tabs.find((t) => t.kind === "file" && t.path === path);
      const target: EditorTab = tab ?? { path, kind: "file", pinned: false };
      addTab(target);
      activateTab(target, line, col);
    },
    [activateTab, addTab, ensureDocument, tabs],
  );

  /**
   * The file a click in the chat asked for. Only the pane on screen takes it —
   * the folders it does not hold stay mounted and would each open the file.
   */
  useEffect(() => {
    if (!active || !revealRequest) return;
    const same = (path: string) => canonicalCwd(path).toLowerCase() === canonicalCwd(root).toLowerCase();
    if (!same(revealRequest.root)) return;
    consumeEditorReveal(revealRequest.seq);
    void openFile(revealRequest.rel, revealRequest.line, revealRequest.col);
  }, [active, consumeEditorReveal, openFile, revealRequest, root]);

  /** Close a tab; a pinned one stays. */
  const closeTab = useCallback(
    (tab: EditorTab) => {
      if (tab.pinned) return;
      const wasActive = tabKey(tab) === activeKey;
      if (tab.kind === "diff") {
        closeDiff();
        diffBaseRef.current.delete(tab.path);
      } else {
        statesRef.current.delete(tab.path);
        setDirty((prev) => {
          const next = new Set(prev);
          next.delete(tab.path);
          return next;
        });
      }
      const rest = tabs.filter((t) => tabKey(t) !== tabKey(tab));
      setTabs(rest);
      if (!wasActive) return;
      // Closing the tab on screen hands the pane to its neighbour, as VS Code does;
      // with no tabs left the document goes away with the tab.
      const index = tabs.findIndex((t) => tabKey(t) === tabKey(tab));
      const next = rest[index] ?? rest[index - 1] ?? null;
      if (next) {
        activateTab(next);
        return;
      }
      activeRef.current = null;
      setActiveKey(null);
      setRefs([]);
      showToast("Все вкладки закрыты", { tone: "info" });
    },
    [activateTab, activeKey, closeDiff, tabs],
  );

  /** Close every tab the predicate does not keep; the pane takes the first kept one. */
  const closeTabs = useCallback(
    (keep: (tab: EditorTab) => boolean) => {
      const kept = tabs.filter(keep);
      const removed = tabs.filter((tab) => !keep(tab));
      if (removed.length === 0) return;
      for (const tab of removed) {
        if (tab.kind === "diff") {
          closeDiff();
          diffBaseRef.current.delete(tab.path);
        } else {
          statesRef.current.delete(tab.path);
        }
      }
      const keptFiles = new Set(kept.filter((tab) => tab.kind === "file").map((tab) => tab.path));
      setDirty((prev) => new Set([...prev].filter((path) => keptFiles.has(path))));
      setTabs(kept);
      const current = tabs.find((tab) => tabKey(tab) === activeKey);
      if (current && !removed.includes(current)) return;
      const next = kept[0];
      if (next) {
        activateTab(next);
        return;
      }
      activeRef.current = null;
      setActiveKey(null);
      setRefs([]);
      showToast("Все вкладки закрыты", { tone: "info" });
    },
    [activateTab, activeKey, closeDiff, tabs],
  );

  const togglePin = useCallback((tab: EditorTab) => {
    setTabs((prev) => {
      const next = prev.map((t) => (tabKey(t) === tabKey(tab) ? { ...t, pinned: !t.pinned } : t));
      // Pinned tabs keep to the left, as in VS Code.
      return [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)];
    });
  }, []);

  const moveTab = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from === to || prev[from]?.pinned || prev[to]?.pinned) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  /** What git says about the pane's folder — the «Изменения» tab. */
  const loadChanges = useCallback(async () => {
    if (!sessionId) return;
    try {
      const status = await api.gitStatus(sessionId);
      setChanges({ repo: status.repo, root: status.root, files: status.files });
    } catch {
      setChanges(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadChanges();
  }, [loadChanges, root]);

  /**
   * VS Code's "Open Changes": the file on the left as the revision has it, the
   * live buffer on the right — and the right side is a real editor, so the diff
   * is where the work happens, not a read-only picture of it.
   */
  const openDiff = useCallback(
    async (path: string) => {
      if (!sessionId || !changes) return;
      try {
        // The ordinary open first: the tab, the language server and the linter,
        // exactly as a plain open would give them.
        await openFile(path);
        const base = await api.gitFileText(sessionId, paneToRepo(changes.root, root, path));
        diffBaseRef.current.set(path, base.text);
        const tab: EditorTab = tabs.find((t) => t.kind === "diff" && t.path === path) ?? {
          path,
          kind: "diff",
          pinned: false,
        };
        addTab(tab);
        activeRef.current = path;
        setActiveKey(tabKey(tab));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Не удалось прочитать изменения", {
          tone: "danger",
        });
      }
    },
    [addTab, changes, openFile, root, sessionId, tabs],
  );

  /** Bring a path on screen: the file tree, its folders open, the row visible. */
  const revealInTree = useCallback((path: string) => {
    setTreeTab("files");
    setTreeHidden(false);
    revealSeq.current += 1;
    setReveal({ path, seq: revealSeq.current });
  }, []);

  // A tab restored from the last session has no document yet: open it the way
  // the tree does, or the pane shows an empty file.
  const selectTab = useCallback(
    (tab: EditorTab, line?: number, col?: number) => {
      if (tab.kind === "diff" && !diffBaseRef.current.has(tab.path)) {
        void openDiff(tab.path);
        return;
      }
      if (tab.kind === "file" && !statesRef.current.has(tab.path)) {
        void openFile(tab.path, line, col);
        return;
      }
      activateTab(tab, line, col);
    },
    [activateTab, openDiff, openFile],
  );

  /** One press of «назад»/«вперёд»: moved, or nothing left in that direction. */
  const navStep = useRef<(dir: 1 | -1) => boolean>(() => false);
  navStep.current = (dir) => {
    const target = navRef.current.step(dir, (step) =>
      tabsRef.current.some((tab) => tabKey(tab) === step.key),
    );
    const tab = target && tabsRef.current.find((item) => tabKey(item) === target.key);
    if (!target || !tab) return false;
    navApplying.current = true;
    if (tab.kind === "file" && !statesRef.current.has(tab.path)) {
      void openFile(tab.path, target.line, target.col).finally(() => {
        navApplying.current = false;
        syncNavFlags();
      });
    } else {
      selectTab(tab, target.line, target.col);
      navApplying.current = false;
    }
    syncNavFlags();
    return true;
  };

  // While the pane is open the browser's back button belongs to it: every press
  // walks the history of visited places, as in VS Code, and only the press that
  // finds nothing left leaves the page. Armed once — the step reads the latest
  // render through a ref, so a re-render never adds a history entry.
  useEffect(() => {
    if (!active) return;
    return trapBrowserBack((dir) => navStep.current(dir));
  }, [active]);

  // Another folder is another set of tabs: its own history starts empty.
  useEffect(() => {
    navRef.current = new NavHistory();
    syncNavFlags();
  }, [root, syncNavFlags]);

  const saveActive = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return;
    const state = statesRef.current.get(path);
    if (!state) return;
    try {
      await editorApi.save(rootRef.current, path, state.doc.toString());
      setDirty((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setStatus(`saved ${path}`);
      // A save changes what git reports: the «Изменения» tab must not be stale.
      void loadChanges();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Не удалось сохранить файл", {
        tone: "danger",
      });
    }
  }, [loadChanges]);

  /** Every changed buffer, as one command — VS Code's "Save All". */
  const saveAll = useCallback(async () => {
    const paths = [...dirty].filter((path) => statesRef.current.has(path));
    if (paths.length === 0) {
      setStatus("нечего сохранять");
      return;
    }
    const failed: string[] = [];
    for (const path of paths) {
      const state = statesRef.current.get(path);
      if (!state) continue;
      try {
        await editorApi.save(rootRef.current, path, state.doc.toString());
        setDirty((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } catch {
        failed.push(path);
      }
    }
    setStatus(failed.length ? `не сохранено: ${failed.join(", ")}` : `saved ${paths.length}`);
    void loadChanges();
  }, [dirty, loadChanges]);

  /** oxfmt runs on the server over the live buffer; the result is one edit. */
  const formatActive = useCallback(async () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path) return;
    const text = view.state.doc.toString();
    try {
      const res = await editorApi.format(rootRef.current, path, text);
      if (res.text === null) {
        // The project does not format here — nothing to run, and nothing broken.
        setStatus(res.note ?? "oxfmt: проект не настроен");
        return;
      }
      if (res.text === text) {
        setStatus("oxfmt: уже отформатировано");
        return;
      }
      view.dispatch({ changes: { from: 0, to: text.length, insert: res.text } });
      setStatus(`oxfmt: ${path}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Не удалось отформатировать файл", {
        tone: "danger",
      });
    }
  }, []);

  // A reload hands back the tabs it had, and the text of every file whose edits
  // never reached the disk. Restoring the active one opens it as a click would.
  useEffect(() => {
    if (!root || restoredFor.current === root) return;
    restoredFor.current = root;
    requestPersistence();
    const workspace = readWorkspace(root);
    const tabs = workspace?.tabs ?? [];
    setTabs(tabs);
    setActiveKey(workspace?.active ?? null);
    for (const [path, at] of Object.entries(workspace?.carets ?? {})) {
      caretsRef.current.set(path, at);
    }
    const reopen = async () => {
      const legacy = Object.entries(workspace?.buffers ?? {});
      if (legacy.length > 0) {
        // Written by a build that kept the text in localStorage: move it across.
        for (const [path, text] of legacy) await saveBuffer(root, path, text);
        writeWorkspace(root, tabs, workspace?.active ?? null);
        restoreBuffers.current = new Map(legacy);
      } else {
        const paths = tabs.filter((tab) => tab.kind === "file").map((tab) => tab.path);
        restoreBuffers.current = await loadBuffers(root, paths);
      }
      const last = tabs.find((tab) => tabKey(tab) === workspace?.active);
      if (!last) return;
      if (last.kind === "diff") void openDiff(last.path);
      else {
        const at = workspace?.carets?.[last.path];
        void openFile(last.path, at?.line, at?.col);
      }
    };
    void reopen();
  }, [openDiff, openFile, root]);

  // The restored diff tab is open before the git status it needs has arrived;
  // until the base is fetched the pane holds nothing, so retry once it lands.
  useEffect(() => {
    const active = tabs.find((tab) => tabKey(tab) === activeKey);
    if (!active || active.kind !== "diff" || !sessionId || !changes) return;
    if (diffBaseRef.current.has(active.path)) return;
    void openDiff(active.path);
  }, [activeKey, changes, openDiff, sessionId, tabs]);

  useEffect(() => {
    if (!root) return;
    // Debounced, and per file: typing in one buffer never rewrites the others.
    const timer = window.setTimeout(() => {
      rememberCaret();
      writeWorkspace(root, tabs, activeKey, caretsOf());
      const writes: Array<Promise<void>> = [];
      for (const path of dirty) {
        const text = statesRef.current.get(path)?.doc.toString();
        if (text == null || persistedRef.current.get(path) === text) continue;
        persistedRef.current.set(path, text);
        writes.push(saveBuffer(root, path, text));
      }
      // Dropping the current entry is allowed while iterating a Map.
      for (const path of persistedRef.current.keys()) {
        if (dirty.has(path)) continue;
        persistedRef.current.delete(path);
        writes.push(dropBuffer(root, path));
      }
      void Promise.all(writes);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [activeKey, caretsOf, dirty, rememberCaret, root, tabs]);

  // A reload or a closed tab gives no time for the debounce: write now.
  useEffect(() => {
    if (!root) return;
    const flush = () => {
      rememberCaret();
      writeWorkspace(root, tabs, activeKey, caretsOf());
      for (const path of dirty) {
        const text = statesRef.current.get(path)?.doc.toString();
        if (text != null) void saveBuffer(root, path, text);
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [activeKey, caretsOf, dirty, rememberCaret, root, tabs]);

  const gotoDefinition = useCallback(async () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path || !lspRef.current) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    setBusy("definition");
    try {
      const root = rootRef.current;
      const name = wordAt(line.text, head - line.from);
      // Both answers are asked for at once: a warm language server replies in
      // tens of milliseconds, a silent one never does, and the project's compiler
      // answers on its own. The first real answer wins, so a click never waits
      // for either of them to give up.
      const fromServer = lspRef.current
        .definition(path, line.number - 1, head - line.from)
        .then((locations) => {
          const hit = locations[0];
          const rel = hit ? relOf(hit.uri) : null;
          // Pointing back into this very file is no answer — the compiler knows better.
          return rel && rel !== path ? { path: rel, line: hit.line, col: hit.col } : null;
        })
        .catch(() => null);
      const fromCompiler = (async () => {
        // A click on the specifier itself needs no name: open what it points at.
        const clicked = importSpecAt(view, head);
        const pointed = clicked
          ? await editorApi.resolve(root, path, clicked).catch(() => null)
          : null;
        if (pointed) return { path: pointed };
        const spec =
          /from\s*["']([^"']+)["']/.exec(line.text)?.[1] ??
          specForName(view.state.doc.toString(), name);
        // No import means the name may still be declared here, next to its use.
        return name ? await editorApi.declaration(root, path, spec ?? "", name).catch(() => null) : null;
      })();
      type Target = { path: string; line?: number; col?: number };
      const found = await Promise.any<Target>(
        [fromServer as Promise<Target | null>, fromCompiler as Promise<Target | null>].map(
          (answer) =>
            answer.then((value) => {
              if (!value) throw new Error("empty");
              return value;
            }),
        ),
      ).catch(() => null);
      if (found) {
        await openFile(found.path, found.line, found.col);
        return;
      }
      setStatus("definition: не найдено");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "definition failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }, [openFile, relOf]);

  const findReferences = useCallback(async () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path || !lspRef.current) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    setBusy("usages");
    try {
      const locations = await lspRef.current.references(path, line.number - 1, head - line.from);
      setRefs(locations.filter((loc) => relOf(loc.uri)));
      setStatus(`references: ${locations.length}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "references failed", { tone: "danger" });
    } finally {
      setBusy(null);
    }
  }, [relOf]);

  handlersRef.current = {
    goto: () => void gotoDefinition(),
    usages: () => void findReferences(),
    save: () => void saveActive(),
    format: () => void formatActive(),
    ask: (pos) => viewRef.current?.dispatch({ effects: setAsk.of(pos) }),
    menu: (request) => setMenu(request),
  };

  // One view for the page; tabs swap its EditorState. Depends on root: before
  // the folder is known the page renders no host, so a mount-only effect would
  // find nothing to attach to and never run again.
  useEffect(() => {
    if (!root || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({ doc: "" }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    mainViewRef.current = view;
    // A fresh view starts blank: put back whatever tab was open.
    const open = activeRef.current;
    const state = open ? statesRef.current.get(open) : null;
    if (state) view.setState(state);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [root]);

  // The diff: a read-only revision on the left, our own editable document on the
  // right. While it is open `viewRef` points at the right side, so saving,
  // formatting, diagnostics and ask all act on what the user is editing.
  useEffect(() => {
    const host = mergeHostRef.current;
    const main = mainViewRef.current;
    const rootPath = rootRef.current;
    if (!diff || !host || !main || !rootPath) return;
    // No placeholder here: an empty state stored for the path would stick and
    // every later open would show the file as an empty document.
    const state = statesRef.current.get(diff.path);
    if (!state) return;
    if (diffMode === "inline") {
      // One column: deletions sit in place with the insertions right below them.
      const view = new EditorView({
        doc: state.doc.toString(),
        extensions: [
          ...docExtensions(diff.path, rootPath),
          unifiedMergeView({ original: diff.base, highlightChanges: true, gutter: true }),
        ],
        parent: host,
      });
      viewRef.current = view;
      statesRef.current.set(diff.path, view.state);
      // A pane restored from the last session is laid out after the view is
      // built: without a nudge CodeMirror keeps the one-line viewport it
      // measured and the diff looks empty.
      const observer = new ResizeObserver(() => view.requestMeasure());
      observer.observe(host);
      applyEditorConfig(view);
      applyDiagnostics(diff.path);
      return () => {
        observer.disconnect();
        statesRef.current.set(diff.path, view.state);
        view.destroy();
        viewRef.current = main;
      };
    }
    const merge = new MergeView({
      a: {
        doc: diff.base,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          themeSlot.of(editorTheme(scheme)),
          // No wrapping here: both halves must lay out the same way, or the right
          // side scrolls sideways against a wrapped left side and the columns
          // stop matching line by line.
        ],
      },
      b: { doc: state.doc.toString(), extensions: docExtensions(diff.path, rootPath) },
      parent: host,
      gutter: true,
      highlightChanges: true,
    });
    mergeRef.current = merge;
    viewRef.current = merge.b;
    const observer = new ResizeObserver(() => {
      merge.a.requestMeasure();
      merge.b.requestMeasure();
    });
    observer.observe(host);
    // The merge view owns the document from now on: its state is the live one.
    statesRef.current.set(diff.path, merge.b.state);
    applyEditorConfig(merge.b);
    applyDiagnostics(diff.path);
    // shortcut: the right side starts with a fresh undo history, so undo across
    // opening a diff stops at the diff. Upgrade when edits have to be undoable
    // through the tab view as one history.
    return () => {
      observer.disconnect();
      statesRef.current.set(diff.path, merge.b.state);
      merge.destroy();
      mergeRef.current = null;
      viewRef.current = main;
    };
  }, [applyDiagnostics, applyEditorConfig, diff, diffMode, docExtensions, makeState, scheme]);

  // Pressing or releasing Ctrl without moving the mouse: the underline follows it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Control" && event.key !== "Meta") return;
      const view = viewRef.current;
      if (!view) return;
      syncLink(view, event.type === "keydown" ? (hoverPoint.get(view) ?? null) : null);
    };
    const onBlur = () => {
      const view = viewRef.current;
      if (view) syncLink(view, null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // A theme or keymap change reaches the open document without reopening it.
  useEffect(() => {
    if (viewRef.current) applyEditorConfig(viewRef.current);
  }, [applyEditorConfig]);

  // Tools of the file in front of the user: they belong to its own project, and
  // the same answer names the folder the language server has to run in.
  useEffect(() => {
    if (!root || !activePath) return;
    void editorApi.tools(root, activePath).then(setTools, () => setTools(null));
  }, [
    root,
    activePath,
    settings.editorToolOxfmt,
    settings.editorToolOxlint,
    settings.editorToolTypescript,
  ]);

  // The language server is per project root: reconnect when the folder changes.
  // It owns the file's own project, not the pane root above it: a repository
  // root makes tsserver load every project inside and answer nothing at all.
  const projectRef = useRef("");
  if (tools?.project) projectRef.current = tools.project;
  const project = projectRef.current;
  useEffect(() => {
    if (!root) return;
    const lsp = new TsLsp(root, project);
    lspRef.current = lsp;
    lsp.onDiagnostics = (path, items) => {
      lspDiagsRef.current.set(path, items);
      applyDiagnostics(path);
    };
    void lsp.ready.then(
      () => {
        setStatus("language server: ready");
        for (const [path, state] of statesRef.current) lsp.open(path, state.doc.toString());
        // Native resolution of the project's own rules arrives when this lands;
        // until then `gotoDefinition` keeps to the compiler path.
        lsp.loadProject();
      },
      (err: Error) => setStatus(`language server: ${err.message}`),
    );
    return () => {
      lsp.dispose();
      lspRef.current = null;
    };
  }, [applyDiagnostics, root, project]);

  // Every menu closes the way a native one does.
  const anyMenu = menu != null || changeMenu != null || tabMenu != null;
  const closeMenus = useCallback(() => {
    setMenu(null);
    setChangeMenu(null);
    setTabMenu(null);
  }, []);
  useOutsidePointerClose(anyMenu, closeMenus);
  useEffect(() => {
    if (!anyMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    const onResize = () => closeMenus();
    // Capture: the editor's own keymap sees Escape first and stops it bubbling.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anyMenu, closeMenus]);

  const commitKey = (action: keyof EditorKeys) => {
    const raw = draftKeys[action].trim();
    const fallback = keys[action];
    if (!isEditorKeyCombo(raw)) {
      setDraftKeys(keys);
      showToast("Такой хоткей не подойдёт — формат: Mod-s, Shift-F12, Ctrl-Alt-k", {
        tone: "danger",
      });
      return;
    }
    if (raw === fallback) return;
    void saveSettings({ [KEY_SETTING[action]]: raw });
  };

  // The menu shows the whole vocabulary but greys out what this file and this
  // spot cannot do — a JSON has no definitions, an unmodified buffer no save.
  const menuTools = activePath ? toolsForPath(activePath) : [];
  const menuWord = menu
    ? wordAt((viewRef.current ?? mainViewRef.current)?.state.doc.toString() ?? "", menu.pos)
    : "";
  const menuCode = menuTools.includes("typescript");

  const menuItem = (label: string, combo: string, run: () => void, enabled = true) => (
    <button
      type="button"
      className={styles.menuItem}
      disabled={!enabled}
      onClick={() => {
        setMenu(null);
        run();
      }}
    >
      <span>{label}</span>
      <span className={styles.menuKey}>{combo}</span>
    </button>
  );

  // «Назад/вперёд» по местам, где читатель уже был. Точка в интерфейсе на
  // выбор: конец полосы вкладок (как в VS Code) или статус-бар.
  const navArrows = (
    <div className={styles.navCluster} role="group" aria-label="Переходы назад и вперёд">
      <button
        type="button"
        className={styles.navArrow}
        disabled={!navFlags.back}
        title="Назад — туда, где читатель был до этого"
        aria-label="Назад"
        onClick={() => navStep.current(-1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <path
            d="M9.5 3.5 5 8l4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <button
        type="button"
        className={styles.navArrow}
        disabled={!navFlags.forward}
        title="Вперёд"
        aria-label="Вперёд"
        onClick={() => navStep.current(1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <path
            d="M6.5 3.5 11 8l-4.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );

  const changeCount = changes?.repo ? changes.files.length : 0;
  // Source-control reads in two groups: what git tracks, and what it has never seen.
  const untrackedChanges = useMemo(
    () => (changes?.files ?? []).filter((file) => file.index === "?" || file.worktree === "?"),
    [changes],
  );
  const trackedChanges = useMemo(
    () => (changes?.files ?? []).filter((file) => !(file.index === "?" || file.worktree === "?")),
    [changes],
  );
  const changedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const file of changes?.files ?? []) {
      const path = changes ? repoToPane(changes.root, root, file.path) : null;
      if (path) set.add(path);
    }
    return set;
  }, [changes, root]);

  if (!root)
    return <div className={styles.page}>Нет папки проекта — откройте сессию с рабочей папкой.</div>;

  return (
    <div
      className={styles.page}
      data-editor-scheme={scheme}
      data-editor-side={settings.editorSplit}
    >
      {/* Всё, что раньше жило в шапке, — хоткеи, правый клик и статус-бар: строку
          на кнопки не тратим, высота нужна документу. */}
      <div className={styles.headerTools}>
        {panelOpen && panelPlacement ? (
          <div
            className={styles.popover}
            role="dialog"
            aria-label="Настройки редактора"
            style={{
              left: panelPlacement.left,
              bottom: panelPlacement.bottom,
              maxHeight: panelPlacement.maxHeight,
            }}
          >
            <div className={styles.popoverHead}>
              <span className={styles.popoverTitle}>Настройки редактора</span>
              <button
                type="button"
                className={styles.popoverClose}
                title="Закрыть настройки"
                aria-label="Закрыть настройки"
                onClick={() => setPanelOpen(false)}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <label className={styles.field}>
              <span>Тема редактора</span>
              <select
                value={settings.editorTheme}
                onChange={(event) =>
                  void saveSettings({ editorTheme: event.target.value as EditorThemeChoice })
                }
              >
                <option value="auto">Как в приложении</option>
                <option value="light">Светлая</option>
                <option value="dark">Тёмная</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Положение рядом с чатом</span>
              <select
                value={settings.editorSplit}
                onChange={(event) =>
                  void saveSettings({ editorSplit: event.target.value as EditorSplit })
                }
              >
                <option value="off">Только редактор по /editor</option>
                <option value="left">Слева от чата</option>
                <option value="right">Справа от чата</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Стрелки «назад / вперёд»</span>
              <select
                value={settings.editorNavPlacement}
                onChange={(event) =>
                  void saveSettings({
                    editorNavPlacement: event.target.value as EditorNavPlacement,
                  })
                }
              >
                <option value="tabs">В полосе вкладок (как в VS Code)</option>
                <option value="statusBar">В статус-баре</option>
              </select>
              <span className={styles.hint}>
                Ходят по местам, где вы уже были: файл и строка, как «назад» в VS Code.
                Кнопка «назад» браузера делает то же, пока открыт редактор.
              </span>
            </label>
            <div className={styles.field}>
              <span>Откуда брать инструменты</span>
              {(
                [
                  [
                    "typescript",
                    "TypeScript",
                    settings.editorToolTypescript,
                    "editorToolTypescript",
                  ],
                  ["oxlint", "oxlint", settings.editorToolOxlint, "editorToolOxlint"],
                  ["oxfmt", "oxfmt", settings.editorToolOxfmt, "editorToolOxfmt"],
                ] as const
              ).map(([tool, label, value, key]) => (
                <label key={tool} className={styles.keyRow}>
                  <span>{label}</span>
                  <select
                    value={value}
                    onChange={(event) =>
                      void saveSettings({
                        [key]: event.target.value as EditorToolSource,
                      } as Partial<AppSettings>)
                    }
                  >
                    <option value="auto">Авто (проект, иначе встроенный)</option>
                    <option value="project">Только из проекта</option>
                    <option value="bundled">Только встроенный</option>
                  </select>
                </label>
              ))}
            </div>
            <div className={styles.field}>
              <span>Хоткеи</span>
              {(Object.keys(KEY_LABELS) as Array<keyof EditorKeys>).map((action) => (
                <label key={action} className={styles.keyRow}>
                  <span>{KEY_LABELS[action]}</span>
                  <input
                    value={draftKeys[action]}
                    spellCheck={false}
                    onChange={(event) =>
                      setDraftKeys((prev) => ({ ...prev, [action]: event.target.value }))
                    }
                    onBlur={() => commitKey(action)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitKey(action);
                      }
                    }}
                  />
                </label>
              ))}
              <span className={styles.hint}>
                Формат CodeMirror: <code>Mod-s</code>, <code>Shift-F12</code>,{" "}
                <code>Ctrl-Alt-k</code>.
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className={styles.body} data-tree-dragging={treeDragging}>
        {treeHidden ? null : (
          <aside className={styles.tree} style={{ width: treeWidth }}>
            <div className={styles.treeTabs}>
              <button
                type="button"
                className={`${styles.treeTab} ${treeTab === "files" ? styles.treeTabActive : ""}`}
                onClick={() => setTreeTab("files")}
              >
                Файлы
              </button>
              <button
                type="button"
                className={`${styles.treeTab} ${treeTab === "changes" ? styles.treeTabActive : ""}`}
                onClick={() => setTreeTab("changes")}
              >
                Изменения
                {changeCount > 0 ? ` (${changeCount})` : ""}
              </button>
              {treeTab === "changes" ? (
                <div className={styles.changeView} role="group" aria-label="Вид списка изменений">
                  <button
                    type="button"
                    className={styles.changeViewButton}
                    aria-pressed={changeView === "tree"}
                    title="Дерево папок"
                    onClick={() => setChangeView("tree")}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M2.5 3h4M2.5 8h4M2.5 13h4M9 8h4M9 13h3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={styles.changeViewButton}
                    aria-pressed={changeView === "list"}
                    title="Плоский список"
                    onClick={() => setChangeView("list")}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              ) : null}
            </div>
            {treeTab === "files" ? (
              <Tree
                root={root}
                onOpen={(path) => void openFile(path)}
                active={activePath}
                changed={changedPaths}
                reveal={reveal}
              />
            ) : (
              <div className={styles.treeList}>
                {changes && !changes.repo ? (
                  <span className={styles.treeNote}>Папка не под git.</span>
                ) : null}
                {changes && changes.repo && changeCount === 0 ? (
                  <span className={styles.treeNote}>Изменений нет.</span>
                ) : null}
                {changes?.repo ? (
                  <>
                    <ChangeGroup
                      title="Изменения"
                      files={trackedChanges}
                      repoRoot={changes.root}
                      paneRoot={root}
                      view={changeView}
                      onOpen={(path) => void openDiff(path)}
                      onMenu={(event, path) =>
                        setChangeMenu({ x: event.clientX, y: event.clientY, path })
                      }
                    />
                    <ChangeGroup
                      title="Неотслеживаемые"
                      files={untrackedChanges}
                      repoRoot={changes.root}
                      paneRoot={root}
                      view={changeView}
                      onOpen={(path) => void openDiff(path)}
                      onMenu={(event, path) =>
                        setChangeMenu({ x: event.clientX, y: event.clientY, path })
                      }
                    />
                  </>
                ) : null}
              </div>
            )}
          </aside>
        )}
        {treeHidden ? null : (
          <span
            className={styles.treeSplitter}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={treeWidth}
            data-dragging={treeDragging}
            title="Потяните, чтобы изменить ширину дерева; двойной клик — сброс"
            onPointerDown={onTreeSplitterDown}
            onDoubleClick={() => setTreeWidth(TREE_DEFAULT)}
          />
        )}

        <main className={styles.main}>
          <div
            className={styles.tabs}
            role="tablist"
            // A wheel over a row that scrolls sideways does nothing by itself:
            // map the vertical detent onto it, as every editor's tab bar does.
            onWheel={(event) => {
              const strip = event.currentTarget;
              if (strip.scrollWidth <= strip.clientWidth) return;
              strip.scrollLeft += event.deltaY + event.deltaX;
            }}
          >
            {tabs.map((tab, index) => (
              <div
                key={tabKey(tab)}
                role="tab"
                aria-selected={tabKey(tab) === activeKey}
                tabIndex={0}
                draggable
                title={tab.path}
                className={`${styles.tab} ${tabKey(tab) === activeKey ? styles.tabActive : ""}`}
                onClick={() => selectTab(tab)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTabMenu({ x: event.clientX, y: event.clientY, tab });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") selectTab(tab);
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(tab);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", String(index));
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const from = Number(event.dataTransfer.getData("text/plain"));
                  if (Number.isInteger(from)) moveTab(from, index);
                }}
              >
                {tab.kind === "diff" ? <span className={styles.tabKind}>±</span> : null}
                <span className={styles.tabName}>{tabTitle(tab)}</span>
                {dirty.has(tab.path) ? <span className={styles.tabDirty}>●</span> : null}
                <button
                  type="button"
                  className={`${styles.tabPin} ${tab.pinned ? styles.tabPinOn : ""}`}
                  title={tab.pinned ? "Открепить" : "Закрепить"}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePin(tab);
                  }}
                >
                  <svg viewBox="0 0 16 16" aria-hidden>
                    <path
                      d="M9.5 1.5 14.5 6.5 12 7l-.6 2.9L8 7.6 3.6 12l-.4-.4 4.4-4.4L5.4 4.6 8.3 4z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                {tab.pinned ? null : (
                  <button
                    type="button"
                    className={styles.tabClose}
                    title="Закрыть"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {/* VS Code's spot: the end of the tab strip, beside the «…» menu. */}
            {settings.editorNavPlacement === "tabs" ? navArrows : null}
          </div>
          <div className={styles.editor} ref={hostRef} hidden={diff != null || !activePath} />
          {!activePath && !diff ? (
            <div className={styles.noTab}>
              <span>Файл не открыт — выберите его в дереве слева</span>
            </div>
          ) : null}
          {/* MergeView mounts here: revision on the left, editable copy on the right. */}
          {diff ? <div className={styles.mergeHost} ref={mergeHostRef} /> : null}
          {diff ? (
            <div className={styles.diffMode} role="group" aria-label="Вид изменений">
              <button
                type="button"
                className={styles.diffModeButton}
                aria-pressed={diffMode === "split"}
                title="Две колонки — было и стало"
                onClick={() => setDiffMode("split")}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  <rect
                    x="1.5"
                    y="2.5"
                    width="5.5"
                    height="11"
                    rx="1"
                    fill="none"
                    stroke="currentColor"
                  />
                  <rect
                    x="9"
                    y="2.5"
                    width="5.5"
                    height="11"
                    rx="1"
                    fill="none"
                    stroke="currentColor"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles.diffModeButton}
                aria-pressed={diffMode === "inline"}
                title="Одна колонка — изменения внутри текста"
                onClick={() => setDiffMode("inline")}
              >
                <svg viewBox="0 0 16 16" aria-hidden>
                  <rect
                    x="1.5"
                    y="2.5"
                    width="13"
                    height="11"
                    rx="1"
                    fill="none"
                    stroke="currentColor"
                  />
                  <path d="M4 6.5h8M4 9.5h8" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
            </div>
          ) : null}
          {refs.length > 0 ? (
            <div className={styles.refs}>
              {refs.map((loc, index) => {
                const rel = relOf(loc.uri);
                return (
                  <button
                    type="button"
                    key={`${loc.uri}:${loc.line}:${index}`}
                    className={styles.refRow}
                    onClick={() => {
                      if (rel) void openFile(rel, loc.line, loc.col);
                    }}
                  >
                    {rel ?? loc.uri}:{loc.line}:{loc.col}
                  </button>
                );
              })}
            </div>
          ) : null}
        </main>
      </div>

      {problemsOpen ? (
        <div className={styles.problems} role="region" aria-label="Проблемы">
          {problems.length === 0 ? (
            <span className={styles.problemEmpty}>Проблем нет — TS и oxlint чисты.</span>
          ) : (
            problems.map((problem) => (
              <button
                type="button"
                key={`${problem.source}:${problem.path}:${problem.line}:${problem.col}:${problem.message}`}
                className={styles.problemRow}
                onClick={() => void openFile(problem.path, problem.line, problem.col)}
              >
                <span
                  className={`${styles.severityDot} ${problem.severity === "error" ? styles.dotError : styles.dotWarn}`}
                />
                <span className={styles.problemSource}>{problem.source}</span>
                <span className={styles.problemText}>{problem.message}</span>
                <span className={styles.problemWhere}>
                  {problem.path}:{problem.line}:{problem.col}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* Статус-бар: самое нужное в одну строку, чтобы не занимать высоту. */}
      <footer className={styles.statusBar}>
        {settings.editorNavPlacement === "statusBar" ? navArrows : null}
        <button
          type="button"
          className={`${styles.barChip} ${styles.barProblems} ${problems.length > 0 ? styles.actionAlert : ""}`}
          aria-expanded={problemsOpen}
          onClick={() => setProblemsOpen((open) => !open)}
          title="Проблемы TS и oxlint"
        >
          {problems.length > 0 ? problemCountLabel(problems) : "0"}
        </button>
        <span className={styles.barText} title={activePath ?? ""}>
          {activePath
            ? `${tabTitle(activeTab ?? { path: activePath, kind: "file", pinned: false })}${activeTab?.kind === "diff" ? " (изменения)" : ""}`
            : "—"}
        </span>
        <span className={styles.barText}>
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        <span className={styles.spacer} />
        {busy ? (
          <span className={`${styles.barText} ${styles.barBusy}`} role="status">
            <span className={styles.barSpinner} aria-hidden />
            {busy === "definition" ? "переход к определению…" : "ищу использования…"}
          </span>
        ) : null}
        {status ? (
          <span className={`${styles.barText} ${styles.barNote}`} title={status}>
            {status}
          </span>
        ) : null}
        <button
          type="button"
          className={`${styles.barChip} ${styles.barAction}`}
          aria-pressed={treeHidden}
          title={treeHidden ? "Показать дерево файлов" : "Скрыть дерево файлов"}
          aria-label={treeHidden ? "Показать дерево" : "Скрыть дерево"}
          onClick={() => setTreeHidden((prev) => !prev)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
            <path
              d={
                treeHidden ? "M2 3.5h12v9H2zM4 6.5h3M4 9h3M9 6.5h3M9 9h3" : "M2 3.5h12v9H2zM6 3.5v9"
              }
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {onToggleChat ? (
          <button
            type="button"
            className={`${styles.barChip} ${styles.barAction}`}
            aria-pressed={Boolean(chatHidden)}
            title={chatHidden ? "Показать чат" : "Скрыть чат — редактор на всю ширину"}
            aria-label={chatHidden ? "Показать чат" : "Скрыть чат"}
            onClick={onToggleChat}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
              {chatHidden ? (
                <path
                  d="M2 3.5h12v9H2zM6 3.5v9M4 6.5l-1.5 1L4 8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M2 3.5h12v9H2zM10 3.5v9M8 7.5l2 1-2 1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.barChip} ${styles.barAction}`}
          aria-expanded={menu != null}
          title="Меню редактора"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({
              x: box.left,
              y: window.innerHeight - box.top + 4,
              pos: viewRef.current?.state.selection.main.head ?? 0,
              up: true,
            });
          }}
        >
          ⋮
        </button>
        <button
          type="button"
          className={`${styles.barChip} ${styles.barAction}`}
          aria-expanded={panelOpen}
          title="Настройки редактора"
          onClick={(event) => {
            if (panelOpen) {
              setPanelOpen(false);
              return;
            }
            const box = event.currentTarget.getBoundingClientRect();
            const maxLeft = window.innerWidth - PANEL_WIDTH - 8;
            // Правый край панели — у правого края кнопки, как у меню в VS Code.
            // Не влезает (панель редактора у левого края) — ведём от левого края кнопки.
            const rightAligned = box.right - PANEL_WIDTH;
            setPanelPlacement({
              left: Math.max(
                8,
                Math.min(rightAligned >= 8 ? rightAligned : box.left, maxLeft),
              ),
              bottom: Math.max(8, window.innerHeight - box.top + 6),
              maxHeight: Math.max(200, box.top - 14),
            });
            setPanelOpen(true);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden className={styles.barGear}>
            <path
              d="M8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6m6 3.1-.9.5a5 5 0 0 1-.3 1l.5.9-1.4 1.4-.9-.5a5 5 0 0 1-1 .3l-.5.9H6.6l-.5-.9a5 5 0 0 1-1-.3l-.9.5L2.8 11l.5-.9a5 5 0 0 1-.3-1l-.9-.5V6.3l.9-.5a5 5 0 0 1 .3-1l-.5-.9 1.4-1.4.9.5a5 5 0 0 1 1-.3l.5-.9h2.8l.5.9a5 5 0 0 1 1 .3l.9-.5 1.4 1.4-.5.9a5 5 0 0 1 .3 1l.9.5z"
              fill="currentColor"
            />
          </svg>
        </button>
        {tools
          ? toolsForPath(activePath).map((name) => {
              const tool = tools.tools[name];
              return (
                <span
                  key={name}
                  className={`${styles.barChip} ${styles.sourceDot} ${SOURCE_CLASS[tool.source]}`}
                  title={`${name} ${tool.version} — ${TOOL_SOURCE_LABEL[tool.source]}`}
                >
                  {TOOL_SHORT[name]} {tool.source === "missing" ? "—" : tool.version}
                </span>
              );
            })
          : null}
      </footer>

      {tabMenu
        ? createPortal(
            <div
              className={styles.menu}
              role="menu"
              style={{ left: Math.min(tabMenu.x, window.innerWidth - MENU_MIN_WIDTH - 8), top: tabMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = tabMenu.tab.path;
                  setTabMenu(null);
                  void copyToClipboard(absOf(root, path), "Путь");
                }}
              >
                <span>Копировать полный путь</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = tabMenu.tab.path;
                  setTabMenu(null);
                  void copyToClipboard(path, "Относительный путь");
                }}
              >
                <span>Копировать относительный путь</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = tabMenu.tab.path;
                  setTabMenu(null);
                  revealInTree(path);
                }}
              >
                <span>Показать файл в дереве</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setTabMenu(null);
                  closeTabs(() => false);
                }}
              >
                <span>Закрыть все</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const keep = tabMenu.tab;
                  setTabMenu(null);
                  closeTabs((tab) => tabKey(tab) === tabKey(keep));
                }}
              >
                <span>Закрыть все, кроме этой</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  setTabMenu(null);
                  closeTabs((tab) => Boolean(tab.pinned));
                }}
              >
                <span>Закрыть все, кроме закреплённых</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {changeMenu
        ? createPortal(
            <div
              className={styles.menu}
              role="menu"
              style={{ left: changeMenu.x, top: changeMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = changeMenu.path;
                  setChangeMenu(null);
                  void openDiff(path);
                }}
              >
                <span>Открыть изменения</span>
                <span className={styles.menuKey}>diff</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = changeMenu.path;
                  setChangeMenu(null);
                  void openFile(path);
                }}
              >
                <span>Открыть файл</span>
                <span className={styles.menuKey}>edit</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = changeMenu.path;
                  setChangeMenu(null);
                  void copyToClipboard(absOf(root, path), "Путь");
                }}
              >
                <span>Копировать полный путь</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = changeMenu.path;
                  setChangeMenu(null);
                  void copyToClipboard(path, "Относительный путь");
                }}
              >
                <span>Копировать относительный путь</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = changeMenu.path;
                  setChangeMenu(null);
                  revealInTree(path);
                }}
              >
                <span>Показать файл в дереве</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {menu
        ? createPortal(
            <div
              className={styles.menu}
              role="menu"
              style={{
                left: Math.min(menu.x, window.innerWidth - MENU_MIN_WIDTH - 8),
                ...(menu.up ? { bottom: menu.y } : { top: menu.y }),
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {menuItem(
                "К определению",
                keys.definition,
                () => void gotoDefinition(),
                menuCode && menuWord !== "",
              )}
              {menuItem(
                "Найти использования",
                keys.usages,
                () => void findReferences(),
                menuCode && menuWord !== "",
              )}
              {menuItem(
                "Спросить про эту строку",
                keys.ask,
                () => viewRef.current?.dispatch({ effects: setAsk.of(menu.pos) }),
                activePath != null,
              )}
              {menuItem(
                "Форматировать файл",
                keys.format,
                () => void formatActive(),
                menuTools.includes("oxfmt"),
              )}
              {menuItem(
                "Сохранить файл",
                keys.save,
                () => void saveActive(),
                activePath != null && dirty.has(activePath),
              )}
              {menuItem(
                `Сохранить все${dirty.size > 1 ? ` (${dirty.size})` : ""}`,
                "",
                () => void saveAll(),
                dirty.size > 0,
              )}
              {menuItem(
                `Проблемы${problems.length > 0 ? ` (${problems.length})` : ""}`,
                "",
                () => setProblemsOpen((open) => !open),
                problems.length > 0,
              )}
              {menuItem("Настройки редактора", "", () => setPanelOpen(true))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Tint per extension, the way an editor's file icon set keys them. */
const EXT_TINTS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#4ec9b0",
  js: "#e2c08d",
  jsx: "#4ec9b0",
  css: "#9d7bd8",
  json: "#cbcf4b",
  md: "#519aba",
  html: "#e37933",
  cs: "#9b6bd6",
  svg: "#9d7bd8",
  yml: "#cbcf4b",
  yaml: "#cbcf4b",
};

function TreeGlyph({ name, dir, open }: { name: string; dir: boolean; open: boolean }) {
  if (dir) {
    return (
      <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden>
        <path
          d={open ? "M1.5 4h4l1.3 1.4h7.7V13H1.5z" : "M1.5 3.5h4.2l1.2 1.4h7.6V12.5H1.5z"}
          fill="currentColor"
          opacity={open ? 0.85 : 0.7}
        />
      </svg>
    );
  }
  const tint = EXT_TINTS[name.split(".").pop()?.toLowerCase() ?? ""] ?? "var(--text-secondary)";
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4 1.5h4.6L12.5 5.4V14.5H4z M8.6 1.5v3.9h3.9"
        fill="none"
        stroke={tint}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Exported for its own test: the reveal behaviour (open folders, ring, scroll).
export function Tree({
  root,
  onOpen,
  active,
  changed,
  reveal,
}: {
  root: string;
  onOpen: (path: string) => void;
  active: string | null;
  /** Files git reports as changed: coloured the way a VS Code tree does it. */
  changed: Set<string>;
  /** A path to bring on screen, with the folders above it opened. */
  reveal?: { path: string; seq: number } | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, EditorEntry[]>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>(() => readPins(root));
  const [pinMenu, setPinMenu] = useState<{ x: number; y: number; entry: EditorEntry } | null>(null);

  const load = useCallback(
    async (path: string) => {
      try {
        const res = await editorApi.tree(root, path);
        setExpanded((prev) => {
          // Keyed by the normalised path: git and the listing may disagree on case.
          const next = { ...prev, [normPath(path)]: res.entries };
          writeTreeOpen(
            root,
            Object.keys(next).filter((item) => item !== ""),
          );
          return next;
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Не удалось прочитать папку", {
          tone: "danger",
        });
      }
    },
    [root],
  );

  useEffect(() => {
    setExpanded({});
    setPins(readPins(root));
    void load("");
    // A reload hands back the folders that were open, in the order they were.
    for (const path of readTreeOpen(root)) void load(path);
  }, [load, root]);

  const togglePin = (path: string) => {
    setPins((prev) => {
      const next = prev.includes(path) ? prev.filter((item) => item !== path) : [path, ...prev];
      try {
        localStorage.setItem(pinsKey(root), JSON.stringify(next));
      } catch {
        // A full quota only costs the pins; the tree still works.
      }
      return next;
    });
  };

  useOutsidePointerClose(pinMenu != null, () => setPinMenu(null));

  // «Показать в дереве»: open the folders above the path, then scroll to its row.
  // The row may need a few frames to exist: the folders above it are loading.
  const select = (path: string, tries = 60): void => {
    // git and the file tree spell a path differently (case, separators), so match
    // on the normalised form or the row is never found.
    const want = normPath(path);
    const row = Array.from(listRef.current?.querySelectorAll("[title]") ?? []).find(
      (el) => normPath(el.getAttribute("title") ?? "") === want,
    );
    if (row) {
      row.scrollIntoView({ block: "center" });
      return;
    }
    if (tries > 0) {
      window.setTimeout(() => select(path, tries - 1), 60);
      return;
    }
    showToast(`В дереве нет файла: ${path}`, { tone: "danger" });
  };
  const revealedSeq = useRef(0);
  useEffect(() => {
    if (!reveal || reveal.seq === revealedSeq.current) return;
    revealedSeq.current = reveal.seq;
    setRevealed(reveal.path);
    const parts = reveal.path.split("/");
    const dirs = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    const opened = new Set(Object.keys(expanded));
    void (async () => {
      for (const dir of dirs) {
        if (opened.has(dir)) continue;
        await load(dir);
        opened.add(dir);
      }
      select(reveal.path);
    })();
    // The ring is a pointer, not a state: it fades out on its own.
    const timer = window.setTimeout(
      () => setRevealed((prev) => (prev === reveal.path ? null : prev)),
      2500,
    );
    return () => window.clearTimeout(timer);
  }, [expanded, load, reveal]);

  // A pinned entry keeps its place above its siblings, in the order it was pinned.
  const rank = (path: string) => {
    const index = pins.indexOf(path);
    return index < 0 ? pins.length : index;
  };
  const ordered = (entries: EditorEntry[]) =>
    entries.length < 2 ? entries : [...entries].sort((a, b) => rank(a.path) - rank(b.path));

  const rows: Array<{ entry: EditorEntry; depth: number }> = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of ordered(expanded[normPath(dir)] ?? [])) {
      rows.push({ entry, depth });
      if (entry.dir && expanded[normPath(entry.path)]) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  return (
    <div className={styles.treeList} ref={listRef}>
      {rows.map(({ entry, depth }) => {
        const open = entry.dir ? Boolean(expanded[normPath(entry.path)]) : false;
        return (
          <button
            type="button"
            key={entry.path}
            title={entry.path}
            className={`${styles.treeRow} ${entry.path === active ? styles.treeRowActive : ""} ${normPath(entry.path) === normPath(revealed ?? "") ? styles.treeRowRevealed : ""}`}
            onContextMenu={(event) => {
              event.preventDefault();
              setPinMenu({ x: event.clientX, y: event.clientY, entry });
            }}
            onClick={() => {
              setRevealed(null);
              if (!entry.dir) {
                onOpen(entry.path);
                return;
              }
              // Second click on a folder folds it, the way a tree should.
              if (expanded[normPath(entry.path)]) {
                setExpanded((prev) => {
                  // Folding a folder folds what was open inside it, as VS Code does;
                  // otherwise the children would pop open again on the next expand.
                  const next = { ...prev };
                  const self = normPath(entry.path);
                  const prefix = `${self}/`;
                  for (const key of Object.keys(next)) {
                    if (key === self || key.startsWith(prefix)) delete next[key];
                  }
                  writeTreeOpen(
                    root,
                    Object.keys(next).filter((item) => item !== ""),
                  );
                  return next;
                });
                return;
              }
              void load(entry.path);
            }}
          >
            {Array.from({ length: depth }, (_, level) => (
              <span key={level} className={styles.guide} aria-hidden />
            ))}
            <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>
              {entry.dir ? (
                <svg viewBox="0 0 16 16">
                  <path
                    d="M6 3.5 10.5 8 6 12.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
              ) : null}
            </span>
            <TreeGlyph name={entry.name} dir={entry.dir} open={open} />
            <span
              className={`${styles.label} ${changed.has(entry.path) ? styles.labelChanged : ""}`}
            >
              {entry.name}
            </span>
            {pins.includes(entry.path) ? (
              <svg className={styles.pinMark} viewBox="0 0 16 16" aria-label="Закреплено">
                <path
                  d="M9.5 1.5 14.5 6.5 12 7l-.6 2.9L8 7.6 3.6 12l-.4-.4 4.4-4.4L5.4 4.6 8.3 4z"
                  fill="currentColor"
                />
              </svg>
            ) : null}
          </button>
        );
      })}
      {pinMenu
        ? createPortal(
            <div
              className={styles.menu}
              role="menu"
              style={{
                left: Math.min(pinMenu.x, window.innerWidth - MENU_MIN_WIDTH - 8),
                top: pinMenu.y,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  togglePin(pinMenu.entry.path);
                  setPinMenu(null);
                }}
              >
                <span>{pins.includes(pinMenu.entry.path) ? "Открепить" : "Закрепить вверху"}</span>
                <span className={styles.menuKey} />
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = pinMenu.entry.path;
                  setPinMenu(null);
                  void copyToClipboard(absOf(root, path), "Путь");
                }}
              >
                <span>Копировать полный путь</span>
              </button>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  const path = pinMenu.entry.path;
                  setPinMenu(null);
                  void copyToClipboard(path, "Относительный путь");
                }}
              >
                <span>Копировать относительный путь</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** A folder or file of the «Изменения» view: git paths are flat, the view is not. */
type ChangeNode = {
  name: string;
  path: string;
  dir: boolean;
  file?: GitChangedFileDto;
  children: ChangeNode[];
};

function changeTreeOf(files: GitChangedFileDto[]): ChangeNode[] {
  const roots: ChangeNode[] = [];
  const byPath = new Map<string, ChangeNode>();
  const node = (path: string, dir: boolean, file?: GitChangedFileDto): ChangeNode => {
    const known = byPath.get(path);
    if (known) {
      if (file) known.file = file;
      return known;
    }
    const created: ChangeNode = {
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      dir,
      file,
      children: [],
    };
    byPath.set(path, created);
    const cut = path.lastIndexOf("/");
    if (cut < 0) roots.push(created);
    else node(path.slice(0, cut), true).children.push(created);
    return created;
  };
  for (const file of files) node(file.path, false, file);
  const sort = (nodes: ChangeNode[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    for (const child of nodes) sort(child.children);
  };
  sort(roots);
  return roots;
}

/**
 * One git group as a tree, the way the source-control view reads: a heading with
 * its own fold state, folders that fold, files that open their diff.
 */
function ChangeGroup({
  title,
  files,
  repoRoot,
  paneRoot,
  view,
  onOpen,
  onMenu,
}: {
  title: string;
  files: GitChangedFileDto[];
  repoRoot: string;
  paneRoot: string;
  view: ChangeView;
  onOpen: (path: string) => void;
  onMenu: (event: ReactMouseEvent, path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => {
    // A flat list is the same files with the whole path as the name: no folders
    // to fold, nothing to hunt for in a deep tree.
    if (view === "list") {
      return [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          node: { name: file.path, path: file.path, dir: false, file, children: [] } as ChangeNode,
          depth: 0,
        }));
    }
    const out: Array<{ node: ChangeNode; depth: number }> = [];
    const walk = (nodes: ChangeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (node.dir && !folded[node.path]) walk(node.children, depth + 1);
      }
    };
    walk(changeTreeOf(files), 0);
    return out;
  }, [files, folded, view]);
  if (files.length === 0) return null;
  return (
    <div className={styles.changeGroup}>
      <button
        type="button"
        className={styles.changeGroupHead}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>
          <svg viewBox="0 0 16 16">
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
        <span className={styles.changeGroupTitle}>{title}</span>
        <span className={styles.changeGroupCount}>{files.length}</span>
      </button>
      {open
        ? rows.map(({ node, depth }) => {
            const where = repoToPane(repoRoot, paneRoot, node.path);
            const letter = node.file
              ? (node.file.index !== " " && node.file.index !== "?"
                  ? node.file.index
                  : node.file.worktree) || "?"
              : "";
            return (
              <button
                type="button"
                key={node.path}
                title={node.dir ? node.path : where ? node.path : `${node.path} — вне корня панели`}
                className={`${styles.treeRow} ${styles.changeRow}`}
                onClick={() => {
                  if (node.dir) {
                    setFolded((prev) => ({ ...prev, [node.path]: !prev[node.path] }));
                    return;
                  }
                  if (where) onOpen(where);
                }}
                onContextMenu={(event) => {
                  if (node.dir || !where) return;
                  event.preventDefault();
                  onMenu(event, where);
                }}
              >
                {Array.from({ length: depth }, (_, level) => (
                  <span key={level} className={styles.guide} aria-hidden />
                ))}
                <span
                  className={`${styles.chevron} ${node.dir && !folded[node.path] ? styles.chevronOpen : ""}`}
                  aria-hidden
                >
                  {node.dir ? (
                    <svg viewBox="0 0 16 16">
                      <path
                        d="M6 3.5 10.5 8 6 12.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                    </svg>
                  ) : (
                    <span className={`${styles.changeBadge} ${letterClass(letter)}`}>{letter}</span>
                  )}
                </span>
                {node.dir ? <TreeGlyph name={node.name} dir open={!folded[node.path]} /> : null}
                <span className={`${styles.label} ${where ? styles.labelChanged : ""}`}>
                  {node.name}
                </span>
                {node.file ? (
                  <span className={styles.changeStat}>
                    {node.file.additions > 0 ? `+${node.file.additions}` : ""}
                    {node.file.deletions > 0 ? ` −${node.file.deletions}` : ""}
                  </span>
                ) : null}
              </button>
            );
          })
        : null}
    </div>
  );
}
