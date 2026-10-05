import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DiffTextView,
  type DiffContextSource,
} from "./DiffTextView";
import { setDiffViewMode, useDiffViewMode } from "../lib/diffViewMode";
import { setDiffLayout, useDiffLayout } from "../lib/diffLayout";
import { MiddleTruncate } from "./MiddleTruncate";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { toggleWrapLines, useWrapLines } from "../lib/wrapLines";
import { buildGitFileTreeRows, normalizeGitPath } from "../lib/gitFileTree";
import styles from "./GitDiffStage.module.css";

/** One selectable row of the file sheet: repo-relative path + status badge. */
export type GitDiffFile = {
  path: string;
  badge?: string;
  additions?: number;
  deletions?: number;
  /** New/untracked file: git reports no line counts, so its diff can be long. */
  untracked?: boolean;
};

export type GitDiffScope = { mode: "working" } | { mode: "commit"; rev: string };

type FileStatus = "idle" | "loading" | "ready" | "error";

type FileEntry = {
  path: string;
  badge?: string;
  additions: number;
  deletions: number;
  untracked: boolean;
  status: FileStatus;
  text: string;
};

type SheetRow = {
  kind: "dir" | "file";
  key: string;
  path: string;
  name: string;
  depth: number;
  index: number;
};

const MAX_PARALLEL_LOADS = 4;
/** Below this many files a plain stacked render is cheaper than windowing. */
const VIRTUAL_MIN_FILES = 10;
const SHEET_VIRTUAL_MIN_ROWS = 30;
const SHEET_ROW_HEIGHT = 46;
const FILE_HEAD_HEIGHT = 30;
const EST_LINE_HEIGHT = 18;
const EST_MAX_LINES = 400;
/** Untracked files show their whole body; assume a page-sized file. */
const EST_NEW_FILE_LINES = 140;
const SCROLL_PROBE = 4;
/**
 * How long a jump may keep correcting for blocks whose height is still being
 * measured. Past that the estimates win and the user gets the scroll back.
 */
const JUMP_ALIGN_BUDGET_MS = 700;
const SHEET_VIEW_KEY = "acpio.gitFileSheetView.v1";
type SheetView = "list" | "tree";

function readSheetView(): SheetView {
  try {
    const raw = localStorage.getItem(SHEET_VIEW_KEY);
    if (raw === "tree" || raw === "list") return raw;
  } catch {
    /* ignore */
  }
  return "list";
}

function writeSheetView(view: SheetView) {
  try {
    localStorage.setItem(SHEET_VIEW_KEY, view);
  } catch {
    /* ignore */
  }
}

/** Rough block height before the diff is in: changed lines + context/hunk headers. */
function estimateEntryHeight(entry: FileEntry | undefined) {
  if (!entry) return 120;
  const changed = Math.min(entry.additions + entry.deletions, EST_MAX_LINES);
  // A file git reports without line counts is new (its whole body shows up) or
  // binary; a lenient default beats jumping to the wrong place later.
  const lines = changed > 0 ? changed + 12 : entry.untracked ? EST_NEW_FILE_LINES : 8;
  return FILE_HEAD_HEIGHT + Math.max(3, lines) * EST_LINE_HEIGHT + 28;
}

function FileStats({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className={styles.fileStats}>
      {additions > 0 ? <span className={styles.fileAdd}>+{additions}</span> : null}
      {deletions > 0 ? <span className={styles.fileDel}>-{deletions}</span> : null}
    </span>
  );
}

/**
 * Placeholder for a block whose diff is still on its way. It reserves the
 * estimated height, so the scroll positions of everything below stay put and a
 * jump to a file lands where it was asked to.
 */
function FileSkeleton({ height }: { height: number }) {
  return (
    <div className={styles.skeleton} style={{ minHeight: height }} aria-hidden>
      <span className={styles.skeletonBar} />
      <span className={styles.skeletonBar} />
      <span className={styles.skeletonBar} />
      <span className={styles.loaderSpin} />
    </div>
  );
}

/**
 * One file's diff. Long lines scroll sideways inside this file's own frame — a
 * shared horizontal scrollbar would drag every sticky file header with it.
 */
function FileBody({ text, contextSource }: { text: string; contextSource?: DiffContextSource }) {
  return (
    <div className={styles.fileBody}>
      <DiffTextView text={text} contextSource={contextSource} toolbar={false} />
    </div>
  );
}

/**
 * Blame for a single file. Same frame as a diff block, but the body is plain
 * text — `DiffTextView` falls back to it for anything that is not a unified diff.
 */
export function GitBlameView({ path, text, onClose }: { path: string; text: string; onClose?: () => void }) {
  const t = useT();
  const wrap = useWrapLines();
  return (
    <section className={styles.stage} aria-label={t("git.blameTitle")}>
      <header className={styles.topBar}>
        {onClose ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            title={t("git.diffStageBack")}
            aria-label={t("git.diffStageBack")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 5l-7 7 7 7"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        <span className={styles.topTitle}>{t("git.blameTitle")}</span>
        <button
          type="button"
          className={`${styles.wrapBtn}${wrap ? ` ${styles.wrapBtnActive}` : ""}`}
          aria-pressed={wrap}
          title={t("common.wrapLines")}
          aria-label={t("common.wrapLines")}
          onClick={toggleWrapLines}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M4 6h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M4 12h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className={styles.scroll}>
        <div className={styles.fileBlock} data-diff-path={path}>
          <div className={styles.fileHead}>
            <span className={styles.fileBadge} aria-hidden>
              B
            </span>
            <MiddleTruncate text={path} className={styles.filePath} />
          </div>
          <FileBody text={text} />
        </div>
      </div>
    </section>
  );
}

/**
 * Stage header: the way back and what the diff below is showing. Shared with the
 * host's own empty states, so a panel that takes the screen over never loses its
 * way out.
 */
export function GitStageHeader({
  title,
  counter,
  flushTop = false,
  onBack,
  actions,
}: {
  title: string;
  counter?: string;
  /** The header sits at the top of the viewport, so it owns the notch inset. */
  flushTop?: boolean;
  /** Rendered as a back chevron; omit where the surrounding panel owns dismissal. */
  onBack?: () => void;
  /** Extra controls pinned to the header's right edge (e.g. the expand toggle). */
  actions?: ReactNode;
}) {
  const t = useT();
  return (
    <header className={`${styles.topBar}${flushTop ? ` ${styles.topBarFlush}` : ""}`}>
      {onBack ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onBack}
          title={t("git.diffStageBack")}
          aria-label={t("git.diffStageBack")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 5l-7 7 7 7"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
      <span className={styles.topTitle}>{title}</span>
      {counter ? <span className={styles.topCounter}>{counter}</span> : null}
      {actions ? <div className={styles.topActions}>{actions}</div> : null}
    </header>
  );
}

/**
 * The diff stage: changed files stack top-to-bottom in one scroll. Each file's
 * diff is fetched on demand as it scrolls into view and only the blocks near the
 * viewport are rendered, so huge changesets open instantly. It is a region, not
 * a dialog — the caller decides where it sits and how it is dismissed.
 */
export function GitDiffStage({
  sessionId,
  scope,
  files,
  initialPath,
  jumpToken = 0,
  reloadToken = 0,
  compact = false,
  expanded = false,
  flushTop = false,
  onToggleExpand,
  onClose,
}: {
  sessionId: string;
  scope: GitDiffScope;
  files: GitDiffFile[];
  /** File to bring into view: the caller's pick on the first open, a jump after that. */
  initialPath: string | null;
  /** Bumped by the caller on every pick, so re-picking the same file still re-centres it. */
  jumpToken?: number;
  /**
   * Bumped by a refresh that must re-read the diffs of the same file set: paths
   * alone do not tell whether a file changed on disk.
   */
  reloadToken?: number;
  /**
   * Narrow host: the stage drops its own bottom bar and file sheet, because the
   * host's navigator is already thumb-reachable and lists the same files.
   */
  compact?: boolean;
  /** The host handed the stage the whole surface: the toggle now offers the way back. */
  expanded?: boolean;
  /** The stage sits at the top of the viewport, so its bar owns the notch inset. */
  flushTop?: boolean;
  /** Renders the full-screen toggle; omit where there is nothing left to expand into. */
  onToggleExpand?: () => void;
  /** Rendered as a back chevron; omit where the surrounding panel owns dismissal. */
  onClose?: () => void;
}) {
  const t = useT();
  const wrap = useWrapLines();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const viewMode = useDiffViewMode();
  const layout = useDiffLayout();
  const single = layout === "single";
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Two-axis viewport of the one-file-per-screen layout. */
  const singleScrollRef = useRef<HTMLDivElement>(null);

  const entriesRef = useRef<FileEntry[]>([]);
  const queueRef = useRef<number[]>([]);
  const queuedRef = useRef<Set<number>>(new Set());
  const inflightRef = useRef(0);
  const generationRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const jumpDeadlineRef = useRef(0);
  /** Height of the pending target's block at the last alignment. */
  const alignedHeightRef = useRef(0);
  /** File the reader is on, so a refreshed list reopens there instead of jumping back. */
  const anchorPathRef = useRef<string | null>(null);
  const currentIndexRef = useRef(0);

  const mode = scope.mode;
  const rev = scope.mode === "commit" ? scope.rev : undefined;
  const fileKey = files.map((file) => normalizeGitPath(file.path)).join("\n");

  // A new file set (or scope) invalidates every loaded diff.
  useEffect(() => {
    // The list can be rebuilt while it is being read (git status is polled, the
    // agent keeps writing files): come back to the file the reader was on, not
    // to the panel's selection.
    anchorPathRef.current = entriesRef.current[currentIndexRef.current]?.path ?? anchorPathRef.current;
    generationRef.current += 1;
    queueRef.current = [];
    queuedRef.current = new Set();
    inflightRef.current = 0;
    const next = files.map<FileEntry>((file) => ({
      path: normalizeGitPath(file.path),
      badge: file.badge,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      untracked: Boolean(file.untracked),
      status: "idle",
      text: "",
    }));
    entriesRef.current = next;
    setEntries(next);
    setCurrentIndex(0);
    initialScrollRef.current = null;
    pendingScrollRef.current = null;
    alignedHeightRef.current = 0;
    // `fileKey` covers the paths; the rest of `files` is metadata for the same rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey, mode, rev, sessionId]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const patchEntry = useCallback((index: number, patch: Partial<FileEntry>) => {
    setEntries((prev) => {
      const current = prev[index];
      if (!current) return prev;
      const next = prev.slice();
      next[index] = { ...current, ...patch };
      return next;
    });
  }, []);

  const pump = useCallback(() => {
    while (inflightRef.current < MAX_PARALLEL_LOADS && queueRef.current.length > 0) {
      const index = queueRef.current.shift()!;
      const entry = entriesRef.current[index];
      if (!entry || entry.status !== "idle") continue;
      const generation = generationRef.current;
      inflightRef.current += 1;
      patchEntry(index, { status: "loading" });
      const request =
        mode === "commit" && rev ? api.gitShow(sessionId, rev, entry.path) : api.gitDiff(sessionId, entry.path);
      request
        .then((result) => {
          if (generation !== generationRef.current) return;
          patchEntry(index, { status: "ready", text: result.diff });
        })
        .catch(() => {
          if (generation === generationRef.current) patchEntry(index, { status: "error" });
        })
        .finally(() => {
          if (generation !== generationRef.current) return;
          inflightRef.current -= 1;
          pump();
        });
    }
  }, [mode, patchEntry, rev, sessionId]);

  const requestDiff = useCallback(
    (index: number) => {
      const entry = entriesRef.current[index];
      if (!entry || entry.status !== "idle" || queuedRef.current.has(index)) return;
      queuedRef.current.add(index);
      queueRef.current.push(index);
      pump();
    },
    [pump],
  );

  // One file per screen has nothing to window: only the visible file renders.
  const virtual = !single && entries.length > VIRTUAL_MIN_FILES;
  const virtualizer = useVirtualizer({
    count: virtual ? entries.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateEntryHeight(entriesRef.current[index]),
    getItemKey: (index) => entriesRef.current[index]?.path ?? index,
    overscan: 4,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const virtualItemsRef = useRef(virtualItems);
  virtualItemsRef.current = virtualItems;
  const virtualRangeKey = virtualItems.map((item) => item.index).join(",");
  const scrollToIndexRef = useRef<((index: number) => void) | null>(null);
  const goToFileRef = useRef<((index: number) => void) | null>(null);
  /** File set that already got its "open on the selected file" scroll. */
  const initialScrollRef = useRef<string | null>(null);

  const hasEntries = entries.length > 0;

  const scrollToPath = useCallback((path: string, smooth: boolean) => {
    const root = scrollRef.current;
    if (!root) return;
    for (const node of root.querySelectorAll<HTMLElement>("[data-diff-path]")) {
      if (node.dataset.diffPath !== path) continue;
      node.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
      return;
    }
  }, []);

  const goto = useCallback(
    (index: number, smooth: boolean) => {
      const entry = entriesRef.current[index];
      if (!entry) return;
      currentIndexRef.current = index;
      setCurrentIndex(index);
      // Single-file layout: the reset effect below brings the viewport back to
      // the top; there is no list offset to scroll to.
      if (single) return;
      if (virtual) {
        // Block heights are estimates until each diff arrives, so the jump is
        // re-aligned by the settle effect below until it actually lands.
        pendingScrollRef.current = index;
        jumpDeadlineRef.current = performance.now() + JUMP_ALIGN_BUDGET_MS;
        alignedHeightRef.current = 0;
        virtualizer.scrollToIndex(index, { align: "start", behavior: smooth ? "smooth" : "auto" });
        return;
      }
      scrollToPath(entry.path, smooth);
    },
    [scrollToPath, single, virtual, virtualizer],
  );

  scrollToIndexRef.current = (index: number) => goto(index, false);

  goToFileRef.current = (index: number) => goto(index, true);

  // A jump lands on an offset that the next arriving diff can move: the block
  // grows when its text shows up, and rows above it re-measure. Keep pulling the
  // target back to the top until its own block stops resizing, but never longer
  // than the budget — a list that keeps re-aligning keeps the user from scrolling.
  useEffect(() => {
    const index = pendingScrollRef.current;
    if (index === null || !virtual || entriesRef.current.length === 0) return;
    const root = scrollRef.current;
    if (!root) return;
    pendingScrollRef.current = null;
    const row = root.querySelector<HTMLElement>(`[data-file-index="${index}"]`);
    // The tail of the list cannot be pulled to the very top: once the scroller
    // is parked at the end, the jump has done all it can.
    const atEnd = root.scrollTop >= root.scrollHeight - root.clientHeight - 1;
    const aligned =
      Boolean(row) &&
      (atEnd || Math.abs(row!.getBoundingClientRect().top - root.getBoundingClientRect().top) <= 1.5);
    const height = row?.offsetHeight ?? 0;
    // In place, and at the height the last alignment used: nothing left to shift it.
    if (aligned && height === alignedHeightRef.current) return;
    // Drift that outlives the budget is the estimates fighting the measurements;
    // chasing it further would only hold the scroll hostage.
    if (!aligned && performance.now() > jumpDeadlineRef.current) return;
    alignedHeightRef.current = height;
    pendingScrollRef.current = index;
    virtualizer.scrollToIndex(index, { align: "start" });
  });

  /**
   * A refresh keeps the same file set, so nothing above invalidates the loaded
   * diffs: mark every entry stale and let the on-screen fetch effects re-request
   * them. The reader's file and scroll anchor survive — only the text is re-read.
   */
  const reloadRef = useRef(reloadToken);
  useEffect(() => {
    if (reloadRef.current === reloadToken) return;
    reloadRef.current = reloadToken;
    if (entriesRef.current.length === 0) return;
    generationRef.current += 1;
    queueRef.current = [];
    queuedRef.current = new Set();
    inflightRef.current = 0;
    const next = entriesRef.current.map<FileEntry>((entry) => ({ ...entry, status: "idle", text: "" }));
    entriesRef.current = next;
    setEntries(next);
  }, [reloadToken]);

  // Fetch what is on screen (plus the virtualizer's overscan) and nothing else.
  useEffect(() => {
    if (single) return;
    const items = virtualItemsRef.current;
    if (virtual) {
      if (items.length === 0) {
        for (let index = 0; index < Math.min(entries.length, 3); index += 1) requestDiff(index);
        return;
      }
      for (const item of items) requestDiff(item.index);
      return;
    }
    for (let index = 0; index < entries.length; index += 1) requestDiff(index);
  }, [entries.length, requestDiff, reloadToken, single, virtual, virtualRangeKey]);

  // One file per screen: the visible file and its neighbours are the only diffs
  // worth loading, so paging does not stall on the network.
  useEffect(() => {
    if (!single) return;
    for (const index of [currentIndex - 1, currentIndex, currentIndex + 1]) {
      if (index >= 0 && index < entries.length) requestDiff(index);
    }
  }, [currentIndex, entries.length, reloadToken, requestDiff, single]);

  // Switching files in the single-file layout starts at the top of the new
  // file, not wherever the previous one was scrolled to.
  useLayoutEffect(() => {
    if (!single) return;
    const root = singleScrollRef.current;
    if (!root) return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }, [currentIndex, single]);

  const syncCurrent = useCallback(() => {
    // The single-file viewport does not map to a list offset.
    if (single) return;
    const root = scrollRef.current;
    if (!root || entriesRef.current.length === 0) return;
    if (virtual) {
      const probe = root.scrollTop + SCROLL_PROBE;
      const items = virtualItemsRef.current;
      const item = items.find((entry) => entry.end > probe) ?? items[0];
      if (item) {
        currentIndexRef.current = item.index;
        setCurrentIndex(item.index);
      }
      return;
    }
    const rootTop = root.getBoundingClientRect().top;
    let index = 0;
    for (const node of root.querySelectorAll<HTMLElement>("[data-file-index]")) {
      const nodeIndex = Number(node.dataset.fileIndex);
      if (!Number.isFinite(nodeIndex)) continue;
      if (node.getBoundingClientRect().top - rootTop <= SCROLL_PROBE) index = nodeIndex;
    }
    currentIndexRef.current = index;
    setCurrentIndex(index);
  }, [single, virtual]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncCurrent);
    };
    // A real gesture wins over a programmatic jump: drop any pending alignment
    // so the list never fights the finger.
    const onUserScroll = () => {
      pendingScrollRef.current = null;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", onUserScroll, { passive: true });
    root.addEventListener("touchstart", onUserScroll, { passive: true });
    syncCurrent();
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onUserScroll);
      root.removeEventListener("touchstart", onUserScroll);
      cancelAnimationFrame(raf);
    };
  }, [syncCurrent]);

  // A pick in the host's navigator re-centres the stage. Tapping the row of the
  // file already being read is a request to go back to its top, so this one is
  // not guarded by "already jumped" — the caller's token says it is a new pick.
  const jumpedTokenRef = useRef(jumpToken);
  useEffect(() => {
    if (jumpedTokenRef.current === jumpToken) return;
    jumpedTokenRef.current = jumpToken;
    const wanted = initialPath ? normalizeGitPath(initialPath) : null;
    if (!wanted || entries.length === 0) return;
    const index = entries.findIndex((entry) => entry.path === wanted);
    if (index < 0) return;
    anchorPathRef.current = wanted;
    // The pick is also this file set's opening jump; the anchor effect below
    // must not fire a second time for the same file.
    initialScrollRef.current = fileKey;
    scrollToIndexRef.current?.(index);
  }, [entries, fileKey, initialPath, jumpToken]);

  // Open on the reader's file — the panel's selection on the first open, the
  // file being read after the list was rebuilt. Once per file set, not on every
  // load: `entries` is a fresh array whenever a diff arrives, and re-running
  // this would yank the view back while the user scrolls.
  useEffect(() => {
    const wanted = anchorPathRef.current ?? initialPath;
    if (!wanted || entries.length === 0) return;
    if (initialScrollRef.current === fileKey) return;
    const index = entries.findIndex((entry) => entry.path === wanted);
    if (index < 0) return;
    // The flag is claimed inside the frame: a re-render that cancels it must
    // reschedule, or a diff landing first would swallow the jump.
    const frame = requestAnimationFrame(() => {
      initialScrollRef.current = fileKey;
      scrollToIndexRef.current?.(index);
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, fileKey, initialPath]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sheetOpen) setSheetOpen(false);
      else onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, sheetOpen]);

  const contextSource = useMemo<DiffContextSource>(
    () => (mode === "commit" && rev ? { sessionId, mode: "commit", commitRev: rev } : { sessionId, mode: "working" }),
    [mode, rev, sessionId],
  );

  const renderHead = (entry: FileEntry, headClass: string): ReactNode => (
    <div className={headClass}>
      <span className={styles.fileBadge} aria-hidden>
        {entry.badge ?? ""}
      </span>
      <MiddleTruncate text={entry.path} className={styles.filePath} />
      <FileStats additions={entry.additions} deletions={entry.deletions} />
    </div>
  );

  const renderBody = (entry: FileEntry): ReactNode =>
    entry.status === "ready" ? (
      entry.text.trim() ? (
        <FileBody text={entry.text} contextSource={contextSource} />
      ) : (
        <div className={styles.fileNote}>{t("git.diffFileEmpty")}</div>
      )
    ) : entry.status === "error" ? (
      <div className={styles.fileNote}>{t("git.diffLoadFailed")}</div>
    ) : (
      <FileSkeleton height={Math.max(90, estimateEntryHeight(entry) - FILE_HEAD_HEIGHT)} />
    );

  const renderBlock = (index: number): ReactNode => {
    const entry = entries[index];
    if (!entry) return null;
    return (
      <div className={styles.fileBlock} data-diff-path={entry.path}>
        {renderHead(entry, styles.fileHead)}
        {renderBody(entry)}
      </div>
    );
  };

  const singleEntry = single ? entries[currentIndex] : undefined;

  return (
    <section className={styles.stage} aria-label={t("git.title")}>
      <GitStageHeader
        title={scope.mode === "commit" ? scope.rev.slice(0, 7) : t("git.tabChanges")}
        counter={
          hasEntries
            ? t("git.diffStageCounter", { index: currentIndex + 1, total: entries.length })
            : undefined
        }
        flushTop={flushTop}
        onBack={onClose}
        actions={
          onToggleExpand ? (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.expandBtn}`}
              onClick={onToggleExpand}
              aria-pressed={expanded}
              title={expanded ? t("git.diffFullscreenExit") : t("git.diffFullscreenOpen")}
              aria-label={expanded ? t("git.diffFullscreenExit") : t("git.diffFullscreenOpen")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                {expanded ? (
                  <path
                    d="M9 4v3.2A1.8 1.8 0 0 1 7.2 9H4M15 4v3.2A1.8 1.8 0 0 0 16.8 9H20M9 20v-3.2A1.8 1.8 0 0 0 7.2 15H4M15 20v-3.2a1.8 1.8 0 0 1 1.8-1.8H20"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <path
                    d="M9 4H5.8A1.8 1.8 0 0 0 4 5.8V9M15 4h3.2A1.8 1.8 0 0 1 20 5.8V9M9 20H5.8A1.8 1.8 0 0 1 4 18.2V15M15 20h3.2a1.8 1.8 0 0 0 1.8-1.8V15"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
            </button>
          ) : null
        }
      />

      {single ? (
        <div className={styles.singleWrap}>
          {singleEntry ? (
            <>
              {renderHead(singleEntry, styles.singleHead)}
              <div className={styles.singleScroll} ref={singleScrollRef}>
                <div className={styles.fileBlock} data-diff-path={singleEntry.path}>
                  {renderBody(singleEntry)}
                </div>
              </div>
            </>
          ) : (
            <div className={styles.state}>{t("git.noChanges")}</div>
          )}
        </div>
      ) : (
        <div className={styles.scroll} ref={scrollRef}>
          {!hasEntries ? (
            <div className={styles.state}>{t("git.noChanges")}</div>
          ) : virtual ? (
            <div className={styles.virtualSpacer} style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((item) => (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-file-index={item.index}
                  className={styles.virtualRow}
                  // `top`, not `transform`: a transformed row is a containing block
                  // that breaks the sticky file header (it never pins to the
                  // scrollport top), which is exactly what the header is for.
                  style={{ top: item.start }}
                >
                  {renderBlock(item.index)}
                </div>
              ))}
            </div>
          ) : (
            entries.map((entry, index) => (
              <div key={entry.path} data-file-index={index}>
                {renderBlock(index)}
              </div>
            ))
          )}
        </div>
      )}

      {hasEntries ? (
        <nav className={styles.bottomBar}>
          {!compact ? (
            <>
              <button
                type="button"
                className={styles.navBtn}
                disabled={currentIndex <= 0}
                onClick={() => goToFileRef.current?.(currentIndex - 1)}
                title={t("git.diffStagePrev")}
                aria-label={t("git.diffStagePrev")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 15l6-6 6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={styles.pickBtn}
                onClick={() => setSheetOpen(true)}
                title={t("git.diffStageFiles")}
                aria-label={t("git.diffStageFiles")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                <MiddleTruncate text={entries[currentIndex]?.path ?? ""} className={styles.pickPath} />
                <span className={styles.pickCount}>{entries.length}</span>
              </button>
              <button
                type="button"
                className={styles.navBtn}
                disabled={currentIndex >= entries.length - 1}
                onClick={() => goToFileRef.current?.(currentIndex + 1)}
                title={t("git.diffStageNext")}
                aria-label={t("git.diffStageNext")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M6 9l6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          ) : null}
          <div className={styles.bottomControls}>
            <div className={styles.modeToggle} role="toolbar" aria-label={t("git.diffViewMode")}>
              <button
                type="button"
                className={`${styles.modeBtn}${viewMode === "unified" ? ` ${styles.modeBtnActive}` : ""}`}
                aria-pressed={viewMode === "unified"}
                aria-label={t("git.diffViewUnified")}
                title={t("git.diffViewUnified")}
                onClick={() => setDiffViewMode("unified")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M4 6h16M4 11h16M4 16h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.modeBtn}${viewMode === "split" ? ` ${styles.modeBtnActive}` : ""}`}
                aria-pressed={viewMode === "split"}
                aria-label={t("git.diffViewSplit")}
                title={t("git.diffViewSplit")}
                onClick={() => setDiffViewMode("split")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="3.5" y="5" width="7" height="14" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="13.5" y="5" width="7" height="14" rx="1.4" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
            </div>
            <div className={styles.modeToggle} role="toolbar" aria-label={t("git.diffLayoutMode")}>
              <button
                type="button"
                className={`${styles.modeBtn}${layout === "stacked" ? ` ${styles.modeBtnActive}` : ""}`}
                aria-pressed={layout === "stacked"}
                aria-label={t("git.diffLayoutStacked")}
                title={t("git.diffLayoutStacked")}
                onClick={() => setDiffLayout("stacked")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="4" y="4.5" width="16" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                  <rect x="4" y="13.5" width="16" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.modeBtn}${layout === "single" ? ` ${styles.modeBtnActive}` : ""}`}
                aria-pressed={layout === "single"}
                aria-label={t("git.diffLayoutSingle")}
                title={t("git.diffLayoutSingle")}
                onClick={() => setDiffLayout("single")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="4" y="3.5" width="16" height="17" rx="1.8" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M4 8.5h16" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className={`${styles.wrapBtn}${wrap && viewMode !== "split" ? ` ${styles.wrapBtnActive}` : ""}`}
              aria-pressed={wrap && viewMode !== "split"}
              disabled={viewMode === "split"}
              title={viewMode === "split" ? t("git.diffWrapSplitHint") : t("common.wrapLines")}
              aria-label={viewMode === "split" ? t("git.diffWrapSplitHint") : t("common.wrapLines")}
              onClick={toggleWrapLines}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 6h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                {wrap ? (
                  <>
                    <path
                      d="M4 12h11a3 3 0 0 1 0 6H8"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M11 15l-3 3 3 3"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </>
                ) : (
                  <>
                    <path d="M4 12h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <path
                      d="M17 9l3 3-3 3"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </nav>
      ) : null}

      {sheetOpen && !compact ? (
        <FileSheet
          entries={entries}
          currentIndex={currentIndex}
          onPick={(index) => {
            setSheetOpen(false);
            goToFileRef.current?.(index);
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </section>
  );
}

/** Bottom sheet with the changed-file list; flat list or path tree, windowed. */
function FileSheet({
  entries,
  currentIndex,
  onPick,
  onClose,
}: {
  entries: FileEntry[];
  currentIndex: number;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [view, setView] = useState<SheetView>(() => readSheetView());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<SheetRow[]>(() => {
    if (view === "tree") {
      return buildGitFileTreeRows(entries, collapsed).map((row) => ({
        kind: row.kind,
        key: row.key,
        path: row.path,
        name: row.name,
        depth: row.depth,
        index: row.kind === "file" ? row.index : -1,
      }));
    }
    return entries.map((entry, index) => ({
      kind: "file" as const,
      key: `f:${index}`,
      path: entry.path,
      name: entry.path,
      depth: 0,
      index,
    }));
  }, [collapsed, entries, view]);
  

  const virtual = rows.length > SHEET_VIRTUAL_MIN_ROWS;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => SHEET_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 8,
  });

  const setViewMode = useCallback((next: SheetView) => {
    setView(next);
    writeSheetView(next);
  }, []);

  // Open the sheet around the file being viewed.
  useEffect(() => {
    if (!virtual) return;
    const index = rows.findIndex((row) => row.kind === "file" && row.index === currentIndex);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => virtualizer.scrollToIndex(index, { align: "center" }));
    return () => cancelAnimationFrame(frame);
    // Only on open: re-centering on every later change would fight the user's scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual]);

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderRow = (row: SheetRow) => {
    if (row.kind === "dir") {
      const folded = collapsed.has(row.path);
      return (
        <button
          type="button"
          className={styles.sheetDir}
          style={{ paddingLeft: 12 + row.depth * 14 }}
          aria-expanded={!folded}
          aria-label={row.path}
          onClick={() => toggleDir(row.path)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M8 6l6 6-6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className={styles.sheetDirName}>{row.name}</span>
        </button>
      );
    }
    const entry = entries[row.index];
    return (
      <button
        type="button"
        className={`${styles.sheetRow}${row.index === currentIndex ? ` ${styles.sheetRowActive}` : ""}`}
        style={row.depth > 0 ? { paddingLeft: 12 + row.depth * 14 } : undefined}
        aria-label={entry?.path ?? row.path}
        onClick={() => onPick(row.index)}
      >
        <span className={styles.sheetBadge} aria-hidden>
          {entries[row.index]?.badge ?? ""}
        </span>
        <MiddleTruncate text={row.name} className={styles.sheetPath} />
        {entries[row.index] ? (
          <span className={styles.sheetStats}>
            <FileStats
              additions={entries[row.index]!.additions}
              deletions={entries[row.index]!.deletions}
            />
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <>
      <button
        type="button"
        className={styles.sheetBackdrop}
        onClick={onClose}
        aria-label={t("common.cancel")}
        tabIndex={-1}
      />
      <div className={styles.sheet} role="dialog" aria-label={t("git.diffStageFiles")}>
        <div className={styles.sheetHead}>
          <span className={styles.sheetTitle}>{t("git.diffStageFiles")}</span>
          <span className={styles.sheetCount}>{entries.length}</span>
          <div className={styles.sheetToggle} role="toolbar" aria-label={t("git.fileViewMode")}>
            <button
              type="button"
              className={`${styles.sheetToggleBtn}${view === "list" ? ` ${styles.sheetToggleBtnActive}` : ""}`}
              aria-pressed={view === "list"}
              aria-label={t("git.fileViewList")}
              title={t("git.fileViewList")}
              onClick={() => setViewMode("list")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={`${styles.sheetToggleBtn}${view === "tree" ? ` ${styles.sheetToggleBtnActive}` : ""}`}
              aria-pressed={view === "tree"}
              aria-label={t("git.fileViewTree")}
              title={t("git.fileViewTree")}
              onClick={() => setViewMode("tree")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 6h6M4 12h6M4 18h6M14 6h6M14 12h6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("common.cancel")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={styles.sheetList} ref={listRef}>
          {virtual ? (
            <div className={styles.sheetSpacer} style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
                    className={styles.sheetVirtualRow}
                    style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                    {renderRow(row)}
                  </div>
                );
              })}
            </div>
          ) : (
            rows.map((row) => <div key={row.key}>{renderRow(row)}</div>)
          )}
        </div>
      </div>
    </>
  );
}
