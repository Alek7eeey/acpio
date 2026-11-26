import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, getChunks, unifiedMergeView } from "@codemirror/merge";
import { api } from "../lib/api";
import { editorApi } from "../lib/editorApi";
import { canOpenInEditor } from "../lib/fileOpen";
import { collapseUnchangedGaps, seedFoldRows } from "../lib/editorDiffCollapse";
import { languageFor } from "../lib/editorLanguage";
import { editorTheme, type EditorScheme } from "../lib/editorTheme";
import { readDiffMode, writeDiffMode, type DiffMode } from "../lib/editorDiffMode";
import { syncMergeScroll } from "../lib/mergeScrollSync";
import { useAppStore } from "../lib/store";
import { useT } from "../lib/i18n";
import styles from "./EditorDiff.module.css";

type Sides = { base: string; text: string };

/** Where the draggable divider between the two columns was left. */
const SPLIT_KEY = "acpio.editorDiffSplit.v1";
/** Narrowest a column may be dragged to. */
const SPLIT_MIN = 120;

function readSplit(): number {
  try {
    const stored = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(stored) && stored >= 0.15 && stored <= 0.85 ? stored : 0.5;
  } catch {
    return 0.5;
  }
}

function writeSplit(fraction: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(fraction));
  } catch {
    // A full quota costs the width, not the diff.
  }
}

/** Open on the change, not on the first line of a file that may be long. */
function showFirstChange(view: EditorView): void {
  const chunk = getChunks(view.state)?.chunks[0];
  if (!chunk) return;
  // A couple of lines of context above the change stay in view.
  const line = view.state.doc.lineAt(chunk.fromB).number;
  const from = view.state.doc.line(Math.max(1, line - 2)).from;
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 2 }) });
}

/**
 * A draggable divider between the two columns, as a diff editor has: the reader
 * decides how much of the pane each side gets, and the choice is remembered.
 * Answers the function that takes it out again.
 */
function attachSplitter(merge: MergeView, title: string): () => void {
  const editors = merge.dom.querySelector(".cm-mergeViewEditors");
  const columns = editors
    ? [...editors.querySelectorAll<HTMLElement>(":scope > .cm-mergeViewEditor")]
    : [];
  const [left, right] = columns;
  if (!editors || !left || !right) return () => {};

  const bar = document.createElement("div");
  bar.className = "cm-diffSplitter";
  bar.dataset.diffSplitter = "true";
  // No `role="separator"`: the git panel hides every separator of its own
  // splitters in its narrow layouts, and this one is not one of them.
  bar.title = title;
  editors.insertBefore(bar, right);

  let fraction = readSplit();
  const apply = () => {
    left.style.flex = `0 0 calc(${(fraction * 100).toFixed(2)}% - 3px)`;
    right.style.flex = "1 1 0";
    merge.a.requestMeasure();
    merge.b.requestMeasure();
  };
  apply();

  let drag: { startX: number; startFraction: number; width: number } | null = null;
  const onDown = (event: PointerEvent) => {
    drag = {
      startX: event.clientX,
      startFraction: fraction,
      width: editors.getBoundingClientRect().width,
    };
    bar.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    event.preventDefault();
  };
  const onMove = (event: PointerEvent) => {
    if (!drag || drag.width <= 0) return;
    const edge = SPLIT_MIN / drag.width;
    fraction = Math.min(
      1 - edge,
      Math.max(edge, drag.startFraction + (event.clientX - drag.startX) / drag.width),
    );
    apply();
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = "";
    writeSplit(fraction);
  };
  const onReset = () => {
    fraction = 0.5;
    writeSplit(fraction);
    apply();
  };

  bar.addEventListener("pointerdown", onDown);
  bar.addEventListener("pointermove", onMove);
  bar.addEventListener("pointerup", onUp);
  bar.addEventListener("pointercancel", onUp);
  bar.addEventListener("dblclick", onReset);
  return () => {
    bar.removeEventListener("pointerdown", onDown);
    bar.removeEventListener("pointermove", onMove);
    bar.removeEventListener("pointerup", onUp);
    bar.removeEventListener("pointercancel", onUp);
    bar.removeEventListener("dblclick", onReset);
    document.body.style.cursor = "";
    bar.remove();
  };
}

/**
 * Both sides already read, per file and per the numbers git reports for it. The
 * panel is a click-through list: going back to a file that was just read must
 * not pay two requests (one of them a `git show`) again.
 */
const sidesCache = new Map<string, Sides>();
const CACHE_LIMIT = 12;

function remember(key: string, sides: Sides): void {
  sidesCache.set(key, sides);
  while (sidesCache.size > CACHE_LIMIT) {
    const oldest = sidesCache.keys().next().value;
    if (oldest === undefined) break;
    sidesCache.delete(oldest);
  }
}

/** Drop what the cache holds — a test's isolation, and a wholesale re-read. */
export function forgetDiffs(): void {
  sidesCache.clear();
}

/**
 * One file's changes, read by the code pane's own diff. The git panel embeds it
 * instead of drawing a diff of its own: a change has to look the same wherever
 * it is looked at, and the editor already knows how to lay one out.
 *
 * Read-only on purpose — the file is edited in the editor, where the buffer,
 * the language server and the save belong; here the right side is what is on
 * disk, exactly as git sees it.
 */
export function EditorDiff({
  sessionId,
  root,
  path,
  deleted = false,
  signature = "",
  compare,
}: {
  sessionId: string;
  /** The folder git talks in: `path` is relative to it. */
  root: string;
  path: string;
  /** Git reports the file gone: there is no working copy to put on the right. */
  deleted?: boolean;
  /**
   * What git says changed about the file (its line counts) plus the reader's
   * refresh: a different value means the sides are read again.
   */
  signature?: string;
  /**
   * Read both sides at these revisions instead of from the disk: a commit's
   * change is what the commit did, and the working copy has nothing to do with
   * it. `from` is the parent (null for a root commit), `fromPath` the name the
   * file had there — a rename reads the old name.
   */
  compare?: { from: string | null; fromPath?: string; to: string };
}) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const scheme: EditorScheme =
    settings.editorTheme === "auto"
      ? settings.theme === "dark"
        ? "dark"
        : "light"
      : settings.editorTheme;
  const [sides, setSides] = useState<{ base: string; text: string } | null>(null);
  /** Why there is nothing to show: a limit, a binary file, or a real failure. */
  const [failed, setFailed] = useState<null | "large" | "binary" | "error">(null);
  const [mode, setMode] = useState<DiffMode>(readDiffMode);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** The words a folded gap's row shows. */
  const labels = useMemo(
    () => ({ hidden: (lines: number) => t("git.diffHiddenLines", { count: lines }) }),
    [t],
  );

  useEffect(() => {
    writeDiffMode(mode);
  }, [mode]);

  /** The working copy against what git holds: a change not yet committed. */
  const readWorking = async (): Promise<Sides> => {
    // The cheap side first: the working copy is one file read, and the pane
    // refuses a file past its limit before anything is transferred. The
    // revision is a `git show`, which for a generated file is megabytes we
    // would fetch only to throw away.
    const text = deleted ? "" : (await editorApi.file(root, path)).text;
    const revision = await api.gitFileText(sessionId, path);
    return { base: revision.text, text };
  };

  /** The two revisions of a commit: its parent's copy and its own. */
  const readRevisions = async (): Promise<Sides> => {
    const [base, committed] = await Promise.all([
      fromRev === null ? { text: "" } : api.gitFileText(sessionId, fromPath, fromRev),
      api.gitFileText(sessionId, path, toRev ?? undefined),
    ]);
    return { base: base.text, text: committed.text };
  };

  // Both sides of the diff: the revision git holds, and the file as it is now.
  // A new file has no revision and a deleted one has no copy — both are a diff
  // of the whole file, which is what the editor shows too.
  // Pulled out of `compare` one by one: an object literal from the parent is a
  // new identity on every render, and the effect below must not re-run for it.
  const fromRev = compare?.from ?? null;
  const fromPath = compare?.fromPath ?? path;
  const toRev = compare?.to ?? null;

  useEffect(() => {
    const key = `${sessionId}\n${path}\n${deleted}\n${signature}\n${fromRev}\n${fromPath}\n${toRev}`;
    const cached = sidesCache.get(key);
    setFailed(null);
    if (cached) {
      setSides(cached);
      return;
    }
    if (!canOpenInEditor(path)) {
      // A picture read as UTF-8 is garbage on the right and megabytes on the
      // wire: the pane has nothing to diff here.
      setSides(null);
      setFailed("binary");
      return;
    }
    let alive = true;
    setSides(null);
    void (async () => {
      try {
        const next = toRev === null ? await readWorking() : await readRevisions();
        if (!alive) return;
        remember(key, next);
        setSides(next);
      } catch (err) {
        // The pane reads a document into an editable buffer, so a file past its
        // limit is refused by the server: say that instead of "failed".
        const message = err instanceof Error ? err.message : "";
        if (alive) setFailed(/too large/i.test(message) ? "large" : "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [deleted, fromPath, fromRev, path, root, sessionId, signature, toRev]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sides) return;
    const theme = editorTheme(scheme);
    const revision = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), theme];
    const working = [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      theme,
      languageFor(path),
    ];
    if (mode === "inline") {
      const view = new EditorView({
        doc: sides.text,
        extensions: [
          ...working,
          collapseUnchangedGaps(labels),
          // No accept/reject: the change is read here and made in the editor.
          unifiedMergeView({
            original: sides.base,
            highlightChanges: true,
            gutter: true,
            mergeControls: false,
          }),
        ],
        parent: host,
      });
      // The diff exists only now: the folds are drawn from it, not from the
      // state `EditorState.create` handed us.
      seedFoldRows(view);
      // A pane laid out after its view was built keeps the one-line viewport it
      // measured: without the nudge the diff reads as an empty file.
      const observer = new ResizeObserver(() => view.requestMeasure());
      observer.observe(host);
      const frame = requestAnimationFrame(() => {
        view.requestMeasure();
        showFirstChange(view);
      });
      return () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        view.destroy();
      };
    }
    const merge = new MergeView({
      a: { doc: sides.base, extensions: [...revision, collapseUnchangedGaps(labels)] },
      b: { doc: sides.text, extensions: [...working, collapseUnchangedGaps(labels)] },
      parent: host,
      gutter: true,
      highlightChanges: true,
    });
    seedFoldRows(merge.a, merge.b);
    const observer = new ResizeObserver(() => {
      merge.a.requestMeasure();
      merge.b.requestMeasure();
    });
    observer.observe(host);
    const unsync = syncMergeScroll(merge.a.scrollDOM, merge.b.scrollDOM);
    const splitter = attachSplitter(merge, t("git.diffSplitHint"));
    const frame = requestAnimationFrame(() => {
      merge.a.requestMeasure();
      merge.b.requestMeasure();
      showFirstChange(merge.b);
    });
    return () => {
      cancelAnimationFrame(frame);
      splitter();
      unsync();
      observer.disconnect();
      merge.destroy();
    };
  }, [labels, mode, path, scheme, sides, t]);

  return (
    <section className={styles.diff} data-editor-diff={path} data-scheme={scheme} aria-label={path}>
      <header className={styles.bar}>
        <span className={styles.path} title={path}>
          {path}
        </span>
        <div className={styles.modes} role="group" aria-label={t("git.diffViewMode")}>
          <button
            type="button"
            className={styles.modeBtn}
            aria-pressed={mode === "split"}
            title={t("git.diffSplit")}
            aria-label={t("git.diffSplit")}
            onClick={() => setMode("split")}
          >
            <svg viewBox="0 0 16 16" aria-hidden>
              <rect x="1.5" y="2.5" width="5.5" height="11" rx="1" fill="none" stroke="currentColor" />
              <rect x="9" y="2.5" width="5.5" height="11" rx="1" fill="none" stroke="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.modeBtn}
            aria-pressed={mode === "inline"}
            title={t("git.diffInline")}
            aria-label={t("git.diffInline")}
            onClick={() => setMode("inline")}
          >
            <svg viewBox="0 0 16 16" aria-hidden>
              <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" />
              <path d="M4 6.5h8M4 9.5h8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>
      {failed ? (
        <div className={styles.note}>
          {failed === "large"
            ? t("git.diffTooLarge")
            : failed === "binary"
              ? t("git.diffBinary")
              : t("git.diffLoadFailed")}
        </div>
      ) : sides === null ? (
        <div className={styles.note} role="status">
          {t("common.loading")}
        </div>
      ) : (
        <div className={styles.host} ref={hostRef} aria-busy={sides === null} />
      )}
    </section>
  );
}
