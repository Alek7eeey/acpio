import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  isEditorKeyCombo,
  type AppSettings,
  type EditorSplit,
  type EditorThemeChoice,
  type EditorToolSource,
} from "@acpio/shared";
import { api } from "../lib/api";
import { editorApi, type EditorEntry, type LintItem, type ToolStatus } from "../lib/editorApi";
import { editorTheme, type EditorScheme } from "../lib/editorTheme";
import { TsLsp, uriToRelPath, type LspLocation } from "../lib/tsLsp";
import { MergeView } from "@codemirror/merge";
import type { GitChangedFileDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { showToast } from "../lib/toast";
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

/** A file and its diff are two tabs over one document, as in VS Code. */
type EditorTab = { path: string; kind: "file" | "diff"; pinned: boolean };

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

const TOOL_SOURCE_LABEL = { project: "проект", bundled: "встроенный", missing: "не настроен" } as const;
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
function stringRangeAt(line: Line, offset: number): { from: number; to: number; text: string } | null {
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
  const endLine = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(item.line, item.endLine)));
  const to = Math.min(endLine.to, endLine.from + Math.max(0, item.endCol - 1));
  return {
    from,
    to: Math.max(to, from),
    severity: item.severity,
    message: item.message,
    source: item.source,
  };
}

export function EditorPage() {
  const root = useAppStore((s) => s.activeSession?.cwd ?? s.knownFolders[0] ?? "");
  const sessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);

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
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [refs, setRefs] = useState<LspLocation[]>([]);
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [treeTab, setTreeTab] = useState<"files" | "changes">("files");
  const [changes, setChanges] = useState<{
    repo: boolean;
    root: string;
    files: GitChangedFileDto[];
  } | null>(null);
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number; path: string } | null>(null);
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
  const rootRef = useRef(root);
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
      const items = [...(oxlintRef.current.get(path) ?? []), ...(lspDiagsRef.current.get(path) ?? [])];
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
      showToast(err instanceof Error ? err.message : "Не удалось отправить вопрос", { tone: "danger" });
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
        effects: [
          themeSlot.reconfigure(editorTheme(scheme)),
          keysSlot.reconfigure(cmKeys(keys)),
        ],
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
    [applyDiagnostics, cmKeys, keys, scheme, sendQuestion],
  );

  const makeState = useCallback(
    (path: string, text: string, rootPath: string) =>
      EditorState.create({ doc: text, extensions: docExtensions(path, rootPath) }),
    [docExtensions],
  );

  /**
   * Everything a plain open does to the document — read it, give it to the
   * language server, lint it. Tabs only decide which view shows it.
   */
  const ensureDocument = useCallback(
    async (path: string) => {
      const rootPath = rootRef.current;
      if (!rootPath) return false;
      if (statesRef.current.has(path)) return true;
      try {
        // Before the state exists: highlighting must be there on the first paint.
        await primeLanguage(path);
        const file = await editorApi.file(rootPath, path);
        statesRef.current.set(path, makeState(path, file.text, rootPath));
        lspRef.current?.open(path, file.text);
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
        showToast(err instanceof Error ? err.message : "Не удалось открыть файл", { tone: "danger" });
        return false;
      }
    },
    [applyDiagnostics, makeState],
  );

  /** Put a tab in front. `line`/`col` only make sense for a file tab. */
  const activateTab = useCallback(
    (tab: EditorTab, line?: number, col?: number) => {
      activeRef.current = tab.path;
      setActiveKey(tabKey(tab));
      applyDiagnostics(tab.path);
      if (tab.kind !== "file") return;
      const view = mainViewRef.current;
      const state = statesRef.current.get(tab.path);
      if (!view || !state) return;
      view.setState(state);
      applyEditorConfig(view);
      if (line != null) {
        const doc = view.state.doc;
        const target = doc.line(Math.min(line, doc.lines));
        const pos = Math.min(target.to, target.from + Math.max(0, (col ?? 1) - 1));
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
      }
      view.focus();
    },
    [applyDiagnostics, applyEditorConfig],
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

  /** Close a tab; a pinned one stays. */
  const closeTab = useCallback(
    (tab: EditorTab) => {
      if (tab.pinned) return;
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
      setTabs((prev) => prev.filter((t) => tabKey(t) !== tabKey(tab)));
    },
    [closeDiff],
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
      // The document first: a file the language server never saw would answer
      // no definitions from either tab.
      if (!(await ensureDocument(path))) return;
      try {
        if (!diffBaseRef.current.has(path)) {
          const base = await api.gitFileText(sessionId, paneToRepo(changes.root, root, path));
          diffBaseRef.current.set(path, base.text);
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Не удалось прочитать изменения", {
          tone: "danger",
        });
        return;
      }
      const tab: EditorTab = tabs.find((t) => t.kind === "diff" && t.path === path) ?? {
        path,
        kind: "diff",
        pinned: false,
      };
      addTab(tab);
      activateTab(tab);
    },
    [activateTab, addTab, changes, ensureDocument, root, sessionId, tabs],
  );

  // No active tab left (the active one was closed): fall back to the last one.
  useEffect(() => {
    if (activeKey && tabs.some((tab) => tabKey(tab) === activeKey)) return;
    const fallback = tabs[tabs.length - 1];
    if (fallback) activateTab(fallback);
    else {
      setActiveKey(null);
      activeRef.current = null;
    }
  }, [activateTab, activeKey, tabs]);

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
      showToast(err instanceof Error ? err.message : "Не удалось сохранить файл", { tone: "danger" });
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

  /**
   * Until tsserver finishes loading the tsconfigs it answers «the import
   * binding» for a symbol from another file. The file is one hop away: open it
   * where the name is declared instead of jumping to the import.
   */
  const followImportBinding = useCallback(
    async (view: EditorView, loc: LspLocation): Promise<boolean> => {
      const path = activeRef.current;
      if (!path || loc.line > view.state.doc.lines) return false;
      const line = view.state.doc.line(loc.line);
      if (!/^\s*(import|export)\b/.test(line.text)) return false;
      const spec = /from\s*["']([^"']+)["']/.exec(line.text)?.[1] ?? null;
      if (!spec) return false;
      // `x as y` imports the name before `as`, not the local alias.
      const name = /^(\w+)/.exec(line.text.slice(loc.col - 1))?.[1] ?? "";
      const target = await editorApi.resolve(rootRef.current, path, spec).catch(() => null);
      if (!target) return false;
      const file = await editorApi.file(rootRef.current, target).catch(() => null);
      if (!file) return false;
      const declaration = new RegExp(
        `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var|function|class|interface|type|enum|abstract\\s+class)\\s+${name}\\b`,
      );
      const lines = file.text.split("\n");
      const at = name ? lines.findIndex((text) => declaration.test(text)) : -1;
      if (at < 0) {
        await openFile(target);
        return true;
      }
      await openFile(target, at + 1, Math.max(0, lines[at].indexOf(name)) + 1);
      return true;
    },
    [openFile],
  );

  const gotoDefinition = useCallback(async () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path || !lspRef.current) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    try {
      const locations = await lspRef.current.definition(path, line.number - 1, head - line.from);
      const first = locations[0];
      const rel = first ? relOf(first.uri) : null;
      if (first && rel === path && (await followImportBinding(view, first))) return;
      if (first && rel) {
        await openFile(rel, first.line, first.col);
        return;
      }
      // A specifier the server cannot resolve is still a file on disk.
      const spec = importSpecAt(view, head);
      const target = spec ? await editorApi.resolve(rootRef.current, path, spec).catch(() => null) : null;
      if (target) {
        await openFile(target);
        return;
      }
      setStatus("definition: не найдено");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "definition failed", { tone: "danger" });
    }
  }, [followImportBinding, openFile, relOf]);

  const findReferences = useCallback(async () => {
    const view = viewRef.current;
    const path = activeRef.current;
    if (!view || !path || !lspRef.current) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    try {
      const locations = await lspRef.current.references(path, line.number - 1, head - line.from);
      setRefs(locations.filter((loc) => relOf(loc.uri)));
      setStatus(`references: ${locations.length}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "references failed", { tone: "danger" });
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
    const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: hostRef.current });
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
    const state = statesRef.current.get(diff.path) ?? makeState(diff.path, "", rootPath);
    const merge = new MergeView({
      a: {
        doc: diff.base,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          themeSlot.of(editorTheme(scheme)),
          EditorView.lineWrapping,
        ],
      },
      b: { doc: state.doc.toString(), extensions: docExtensions(diff.path, rootPath) },
      parent: host,
      gutter: true,
      highlightChanges: true,
    });
    mergeRef.current = merge;
    viewRef.current = merge.b;
    // The merge view owns the document from now on: its state is the live one.
    statesRef.current.set(diff.path, merge.b.state);
    applyEditorConfig(merge.b);
    applyDiagnostics(diff.path);
    // shortcut: the right side starts with a fresh undo history, so undo across
    // opening a diff stops at the diff. Upgrade when edits have to be undoable
    // through the tab view as one history.
    return () => {
      statesRef.current.set(diff.path, merge.b.state);
      merge.destroy();
      mergeRef.current = null;
      viewRef.current = main;
    };
  }, [applyDiagnostics, applyEditorConfig, diff, docExtensions, makeState, scheme]);

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
  }, [root, activePath, settings.editorToolOxfmt, settings.editorToolOxlint, settings.editorToolTypescript]);

  const project = tools?.project ?? "";

  // One language server per project of the open file: a pane opened on a
  // repository above `web/` still needs `web/tsconfig.json`. Reconnects when the
  // project or the TypeScript copy changes, so the chosen one is the one that runs.
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
      },
      (err: Error) => setStatus(`language server: ${err.message}`),
    );
    return () => {
      lsp.dispose();
      lspRef.current = null;
    };
  }, [applyDiagnostics, project, root, settings.editorToolTypescript]);

  // Both menus close the way a native one does.
  const anyMenu = menu != null || changeMenu != null;
  useEffect(() => {
    if (!anyMenu) return;
    const close = () => {
      setMenu(null);
      setChangeMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close, true);
    // Capture: the editor's own keymap sees Escape first and stops it bubbling.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [anyMenu]);

  // The settings popover closes on a click outside it, like the menus above;
  // the button itself is outside this listener because it sits in the same box.
  useEffect(() => {
    if (!panelOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest("[data-editor-tools]")) setPanelOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [panelOpen]);

  const commitKey = (action: keyof EditorKeys) => {
    const raw = draftKeys[action].trim();
    const fallback = keys[action];
    if (!isEditorKeyCombo(raw)) {
      setDraftKeys(keys);
      showToast("Такой хоткей не подойдёт — формат: Mod-s, Shift-F12, Ctrl-Alt-k", { tone: "danger" });
      return;
    }
    if (raw === fallback) return;
    void saveSettings({ [KEY_SETTING[action]]: raw });
  };

  const menuItem = (label: string, combo: string, run: () => void) => (
    <button
      type="button"
      className={styles.menuItem}
      onClick={() => {
        setMenu(null);
        run();
      }}
    >
      <span>{label}</span>
      <span className={styles.menuKey}>{combo}</span>
    </button>
  );

  const changeCount = changes?.repo ? changes.files.length : 0;
  const changedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const file of changes?.files ?? []) {
      const path = changes ? repoToPane(changes.root, root, file.path) : null;
      if (path) set.add(path);
    }
    return set;
  }, [changes, root]);

  if (!root) return <div className={styles.page}>Нет папки проекта — откройте сессию с рабочей папкой.</div>;

  return (
    <div
      className={styles.page}
      data-editor-scheme={scheme}
      data-editor-side={settings.editorSplit}
    >
      {/* Всё, что раньше жило в шапке, — хоткеи, правый клик и статус-бар: строку
          на кнопки не тратим, высота нужна документу. */}
      <div className={styles.headerTools} data-editor-tools>
          {panelOpen ? (
            <div className={styles.popover} role="dialog" aria-label="Настройки редактора">
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
              <div className={styles.field}>
                <span>Откуда брать инструменты</span>
                {([
                  ["typescript", "TypeScript", settings.editorToolTypescript, "editorToolTypescript"],
                  ["oxlint", "oxlint", settings.editorToolOxlint, "editorToolOxlint"],
                  ["oxfmt", "oxfmt", settings.editorToolOxfmt, "editorToolOxfmt"],
                ] as const).map(([tool, label, value, key]) => (
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
                  Формат CodeMirror: <code>Mod-s</code>, <code>Shift-F12</code>, <code>Ctrl-Alt-k</code>.
                </span>
              </div>
            </div>
          ) : null}
      </div>

      <div className={styles.body}>
        <aside className={styles.tree}>
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
          </div>
          {treeTab === "files" ? (
            <Tree
              root={root}
              onOpen={(path) => void openFile(path)}
              active={activePath}
              changed={changedPaths}
            />
          ) : (
            <div className={styles.treeList}>
              {changes && !changes.repo ? (
                <span className={styles.treeNote}>Папка не под git.</span>
              ) : null}
              {changes && changes.repo && changeCount === 0 ? (
                <span className={styles.treeNote}>Изменений нет.</span>
              ) : null}
              {(changes?.files ?? []).map((file) => {
                const path = changes ? repoToPane(changes.root, root, file.path) : null;
                const where = path == null ? null : path;
                const letter = (file.index !== " " && file.index !== "?" ? file.index : file.worktree) || "?";
                return (
                  <button
                    type="button"
                    key={file.path}
                    title={where ? file.path : `${file.path} — вне корня панели`}
                    className={`${styles.treeRow} ${styles.changeRow}`}
                    onClick={() => where && void openDiff(where)}
                    onContextMenu={(event) => {
                      if (!where) return;
                      event.preventDefault();
                      setChangeMenu({ x: event.clientX, y: event.clientY, path: where });
                    }}
                  >
                    <span className={`${styles.changeBadge} ${letterClass(letter)}`}>{letter}</span>
                    <span className={`${styles.label} ${where ? styles.labelChanged : ""}`}>
                      {file.path.split("/").pop()}
                    </span>
                    <span className={styles.changeStat}>
                      {file.additions > 0 ? `+${file.additions}` : ""}
                      {file.deletions > 0 ? ` −${file.deletions}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <main className={styles.main}>
          <div className={styles.tabs} role="tablist">
            {tabs.map((tab, index) => (
              <div
                key={tabKey(tab)}
                role="tab"
                aria-selected={tabKey(tab) === activeKey}
                tabIndex={0}
                draggable
                title={tab.path}
                className={`${styles.tab} ${tabKey(tab) === activeKey ? styles.tabActive : ""}`}
                onClick={() => activateTab(tab)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") activateTab(tab);
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
          </div>
          <div className={styles.editor} ref={hostRef} hidden={diff != null} />
          {/* MergeView mounts here: revision on the left, editable copy on the right. */}
          {diff ? <div className={styles.mergeHost} ref={mergeHostRef} /> : null}
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
          {activePath ? `${tabTitle(activeTab ?? { path: activePath, kind: "file", pinned: false })}${activeTab?.kind === "diff" ? " (изменения)" : ""}` : "—"}
        </span>
        <span className={styles.barText}>
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        <span className={styles.spacer} />
        {status ? (
          <span className={`${styles.barText} ${styles.barNote}`} title={status}>
            {status}
          </span>
        ) : null}
        <button
          type="button"
          className={`${styles.barChip} ${styles.barAction}`}
          aria-expanded={menu != null}
          title="Меню редактора"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({
              // Строка кончается у правого края: без сдвига меню уезжает за экран.
              x: Math.min(box.left, window.innerWidth - MENU_MIN_WIDTH - 8),
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
          onClick={() => setPanelOpen((open) => !open)}
        >
          <svg viewBox="0 0 16 16" aria-hidden className={styles.barGear}>
            <path
              d="M8 5.6A2.4 2.4 0 1 0 8 10.4 2.4 2.4 0 0 0 8 5.6m6 3.1-.9.5a5 5 0 0 1-.3 1l.5.9-1.4 1.4-.9-.5a5 5 0 0 1-1 .3l-.5.9H6.6l-.5-.9a5 5 0 0 1-1-.3l-.9.5L2.8 11l.5-.9a5 5 0 0 1-.3-1l-.9-.5V6.3l.9-.5a5 5 0 0 1 .3-1l-.5-.9 1.4-1.4.9.5a5 5 0 0 1 1-.3l.5-.9h2.8l.5.9a5 5 0 0 1 1 .3l.9-.5 1.4 1.4-.5.9a5 5 0 0 1 .3 1l.9.5z"
              fill="currentColor"
            />
          </svg>
        </button>
        {tools
          ? (["typescript", "oxlint", "oxfmt"] as const).map((name) => {
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
            </div>,
            document.body,
          )
        : null}

      {menu
        ? createPortal(
            <div
              className={styles.menu}
              role="menu"
              style={menu.up ? { left: menu.x, bottom: menu.y } : { left: menu.x, top: menu.y }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {menuItem("К определению", keys.definition, () => void gotoDefinition())}
              {menuItem("Найти использования", keys.usages, () => void findReferences())}
              {menuItem("Спросить про эту строку", keys.ask, () =>
                viewRef.current?.dispatch({ effects: setAsk.of(menu.pos) }),
              )}
              {menuItem("Форматировать файл", keys.format, () => void formatActive())}
              {menuItem("Сохранить файл", keys.save, () => void saveActive())}
              {menuItem(`Сохранить все${dirty.size > 1 ? ` (${dirty.size})` : ""}`, "", () => void saveAll())}
              {menuItem(
                `Проблемы${problems.length > 0 ? ` (${problems.length})` : ""}`,
                "",
                () => setProblemsOpen((open) => !open),
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

function Tree({
  root,
  onOpen,
  active,
  changed,
}: {
  root: string;
  onOpen: (path: string) => void;
  active: string | null;
  /** Files git reports as changed: coloured the way a VS Code tree does it. */
  changed: Set<string>;
}) {
  const [expanded, setExpanded] = useState<Record<string, EditorEntry[]>>({});

  const load = useCallback(
    async (path: string) => {
      try {
        const res = await editorApi.tree(root, path);
        setExpanded((prev) => ({ ...prev, [path]: res.entries }));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Не удалось прочитать папку", { tone: "danger" });
      }
    },
    [root],
  );

  useEffect(() => {
    setExpanded({});
    void load("");
  }, [load]);

  const rows: Array<{ entry: EditorEntry; depth: number }> = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of expanded[dir] ?? []) {
      rows.push({ entry, depth });
      if (entry.dir && expanded[entry.path]) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);

  return (
    <div className={styles.treeList}>
      {rows.map(({ entry, depth }) => {
        const open = entry.dir ? Boolean(expanded[entry.path]) : false;
        return (
          <button
            type="button"
            key={entry.path}
            title={entry.path}
            className={`${styles.treeRow} ${entry.path === active ? styles.treeRowActive : ""}`}
            onClick={() => (entry.dir ? void load(entry.path) : onOpen(entry.path))}
          >
            {Array.from({ length: depth }, (_, level) => (
              <span key={level} className={styles.guide} aria-hidden />
            ))}
            <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} aria-hidden>
              {entry.dir ? (
                <svg viewBox="0 0 16 16">
                  <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              ) : null}
            </span>
            <TreeGlyph name={entry.name} dir={entry.dir} open={open} />
            <span className={`${styles.label} ${changed.has(entry.path) ? styles.labelChanged : ""}`}>
              {entry.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
