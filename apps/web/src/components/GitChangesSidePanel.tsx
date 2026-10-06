import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { GitCommitDetailDto, GitCommitDto, GitCommitFileDto, GitStatusDto } from "@acpio/shared";
import {
  GitBlameView,
  GitDiffStage,
  GitStageHeader,
  type GitDiffFile,
  type GitDiffScope,
} from "./GitDiffStage";
import {
  CHANGES_VIEW_KEY,
  GitChangesCommitPane,
  readChangesView,
  type ChangesView,
} from "./GitChangesCommitPane";
import { GitCommitHistory } from "./GitCommitHistory";
import { GitCommitDetail } from "./GitCommitDetail";
import { GitBranchSwitcher, type GitBranchDeleteOutcome } from "./ComposerGitBar";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { showToast } from "../lib/toast";
import {
  isSidePanelResizeAllowed,
  useNarrowPanelLayout,
  usePhonePanelLayout,
} from "../lib/panelLayout";
import {
  GIT_NAVIGATOR_MIN_WIDTH,
  GIT_PANEL_WIDTH_MAX,
  GIT_PANEL_WIDTH_MIN,
  GIT_SPLIT_MIN_WIDTH,
  GIT_STAGE_MIN_WIDTH,
  clampGitPanelWidth,
  gitDefaultPanelWidth,
  gitNavigatorWidthFor,
} from "../lib/gitLayout";
import { normalizeGitPath } from "../lib/gitFileTree";
import { formatGitErrorToast, gitConflictFiles, gitPullConflictMessage, gitStatusBadge, gitSyncSuccessMessage, isGitConflictFile, isUntrackedGitFile } from "../lib/gitUi";
import styles from "./GitChangesSidePanel.module.css";

/** Assumed width of the ops menu, used to keep it inside the viewport. */
const OPS_MENU_WIDTH = 200;

/**
 * Floor for how long the refresh button keeps spinning. A local repo answers in a
 * few milliseconds, and a flash that short reads as a dead button rather than as
 * an update — the floor is what makes the click's start and end legible.
 */
const REFRESH_MIN_VISIBLE_MS = 450;

/** Single-letter badge for a commit file row in the stage's file list. */
const COMMIT_FILE_BADGE: Record<GitCommitFileDto["status"], string> = {
  added: "A",
  copied: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  typeChanged: "T",
  other: "M",
};
/** Which list the navigator column is showing. */
type PanelTab = "changes" | "history";

/** One icon button of the navigator toolbar, hideable into the "…" menu. */
type GitToolAction = {
  id: string;
  title: string;
  disabled: boolean;
  run: () => void;
  icon: ReactNode;
};

/**
 * Geometry of the toolbar's icon buttons, used to compute how many fit before
 * the rest fold into the "…" menu: `.iconBtn` is 30px wide, the actions group
 * gaps them by 2px, and the toolbar row gaps its groups by 8px.
 */
const TOOL_BUTTON_STEP = 32;
const TOOL_ROW_GAP = 8;
type Selection =
  | { kind: "working"; path: string | null }
  | { kind: "commit"; hash: string; filePath: string | null };

/** Reader-dragged dock width, remembered per browser. */
const PANEL_WIDTH_KEY = "acpio.gitPanelWidth.v1";

function readStoredPanelWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Reader-dragged navigator (changes column) width, remembered per browser. */
const NAVIGATOR_WIDTH_KEY = "acpio.gitNavigatorWidth.v1";

/** Height of the commit list inside the history tab, dragged by its splitter. */
const HISTORY_LIST_HEIGHT_KEY = "acpio.gitHistoryListHeight.v1";
const HISTORY_LIST_HEIGHT_MIN = 100;
const HISTORY_LIST_HEIGHT_MAX = 900;

function readStoredHistoryListHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(HISTORY_LIST_HEIGHT_KEY));
    return Number.isFinite(n) && n > 0
      ? Math.min(HISTORY_LIST_HEIGHT_MAX, Math.max(HISTORY_LIST_HEIGHT_MIN, n))
      : null;
  } catch {
    return null;
  }
}

function readStoredNavigatorWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(NAVIGATOR_WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function GitChangesSidePanel({
  sessionId,
  open,
  status,
  statusLoading = false,
  awaitingGit = false,
  branchBusy,
  fullscreen,
  onClose,
  onStatusChange,
  onCheckout,
  onDeleteBranch,
  onFullscreenChange,
}: {
  sessionId: string;
  open: boolean;
  status: GitStatusDto | null;
  statusLoading?: boolean;
  awaitingGit?: boolean;
  branchBusy: boolean;
  /** Reader asked for the diff alone: the chat steps aside and the page is the review. */
  fullscreen: boolean;
  onClose: () => void;
  onStatusChange: (status: GitStatusDto) => void;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
  onDeleteBranch: (branch: string, opts?: { force?: boolean }) => Promise<GitBranchDeleteOutcome>;
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const t = useT();
  const narrowPanel = useNarrowPanelLayout();
  const phonePanel = usePhonePanelLayout();
  const syncInFlightRef = useRef(false);
  const [tab, setTab] = useState<PanelTab>("changes");
  const [selection, setSelection] = useState<Selection>({ kind: "working", path: null });
  /** Bumped on every file pick so the stage re-centres even on the same path. */
  const [jumpToken, setJumpToken] = useState(0);
  /** Bumped on refresh so the stage re-reads diffs whose paths did not change. */
  const [reloadToken, setReloadToken] = useState(0);
  /** A manual refresh is in flight: the footer button turns and refuses re-clicks. */
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  /** Fetch and the stash pair are rare next to pull/push: they live behind one button. */
  const [opsAnchor, setOpsAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const opsRef = useRef<HTMLButtonElement | null>(null);
  const opsMenuRef = useRef<HTMLDivElement | null>(null);
  /** Hover intent: leaving the ⋯ button or its menu closes after a short grace. */
  const opsHoverTimerRef = useRef<number | null>(null);
  /** List or tree: the commit pane's file rows, switched from the navigator header. */
  const [view, setView] = useState<ChangesView>(readChangesView);
  /**
   * How many of the toolbar's trailing action buttons fit the row's width; the
   * rest fold into the "…" menu. Measured, not guessed from a breakpoint, so it
   * follows both the dragged navigator width and the tab's leading controls.
   */
  const [visibleActions, setVisibleActions] = useState(6);
  /* Callback refs: the toolbar mounts only once the repo status has loaded, so
     a plain mount effect would measure nothing and never run again. */
  const [toolsEl, setToolsEl] = useState<HTMLDivElement | null>(null);
  const [toolsLeadEl, setToolsLeadEl] = useState<HTMLDivElement | null>(null);
  const [blame, setBlame] = useState<{ path: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitSummary, setCommitSummary] = useState("");
  const [commitDescription, setCommitDescription] = useState("");
  const [commits, setCommits] = useState<GitCommitDto[]>([]);
  const [outgoing, setOutgoing] = useState<GitCommitDto[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetailDto | null>(null);
  const [loadingCommitDetail, setLoadingCommitDetail] = useState(false);
  /** Width of the page this panel is docked into — the panel's own width follows from it. */
  const [pageWidth, setPageWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  const panelRef = useRef<HTMLElement | null>(null);
  /** Null until dragged: whoever has not touched the splitter follows the default. */
  const [draggedWidth, setDraggedWidth] = useState<number | null>(readStoredPanelWidth);
  const [resizing, setResizing] = useState(false);
  const resizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /** Dragged width of the navigator column (the changes list) inside the dock. */
  const [draggedNavigatorWidth, setDraggedNavigatorWidth] = useState<number | null>(readStoredNavigatorWidth);
  const [navResizing, setNavResizing] = useState(false);
  const navResizeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /** Dragged height of the commit list in the history tab. */
  const [historyListHeight, setHistoryListHeight] = useState<number | null>(readStoredHistoryListHeight);
  const [historyResizing, setHistoryResizing] = useState(false);
  const historyResizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    if (draggedWidth === null) return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(draggedWidth));
    } catch {
      /* ignore */
    }
  }, [draggedWidth]);

  useEffect(() => {
    if (draggedNavigatorWidth === null) return;
    try {
      localStorage.setItem(NAVIGATOR_WIDTH_KEY, String(draggedNavigatorWidth));
    } catch {
      /* ignore */
    }
  }, [draggedNavigatorWidth]);

  /**
   * The dock takes a slice of the page and the navigator takes a slice of the
   * dock, so the diff keeps the rest. The slice is what the reader dragged, fitted
   * to the page; before the first drag it is the default. Below
   * `GIT_SPLIT_MIN_WIDTH` there is no rest to keep, and the navigator becomes a
   * sheet over the stage instead of a column beside it.
   */
  const overlay = narrowPanel;
  /**
   * Phone: the panel is the whole viewport. The shell parks a chat dock under the
   * page and a header above it, and both would box the review in — leaving the
   * diff a slice short of the screen and the chats sheet callable from it.
   */
  const takeover = overlay && phonePanel;
  const panelWidth = overlay
    ? pageWidth
    : clampGitPanelWidth(draggedWidth ?? gitDefaultPanelWidth(pageWidth), pageWidth);
  const navigatorWidth = draggedNavigatorWidth
    ? Math.min(
        Math.max(GIT_NAVIGATOR_MIN_WIDTH, panelWidth - GIT_STAGE_MIN_WIDTH),
        Math.max(GIT_NAVIGATOR_MIN_WIDTH, draggedNavigatorWidth),
      )
    : gitNavigatorWidthFor(panelWidth);
  /* The bottom sheet is for phone-width overlay only; a docked desktop panel
     always keeps the split navigator column, however narrow the user drags it. */
  const sheetNavigator = overlay && panelWidth < GIT_SPLIT_MIN_WIDTH;

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeDragRef.current = { startX: e.clientX, startWidth: panelWidth };
      setResizing(true);
    },
    [panelWidth],
  );

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      // Dragging left grows the dock, which sits on the right edge of the page.
      setDraggedWidth(clampGitPanelWidth(drag.startWidth - (e.clientX - drag.startX), pageWidth));
    };
    const onUp = () => {
      resizeDragRef.current = null;
      setResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [pageWidth, resizing]);

  useEffect(() => {
    if (!resizing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add(styles.resizingBody);
    return () => {
      document.body.style.cursor = prev;
      document.body.classList.remove(styles.resizingBody);
    };
  }, [resizing]);

  const onNavigatorSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      navResizeDragRef.current = { startX: e.clientX, startWidth: navigatorWidth };
      setNavResizing(true);
    },
    [navigatorWidth],
  );

  const resetNavigatorWidth = useCallback(() => {
    setDraggedNavigatorWidth(null);
    try {
      localStorage.removeItem(NAVIGATOR_WIDTH_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const onHistorySplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      historyResizeDragRef.current = {
        startY: e.clientY,
        startHeight: historyListHeight ?? 300,
      };
      setHistoryResizing(true);
    },
    [historyListHeight],
  );

  const resetHistoryListHeight = useCallback(() => {
    setHistoryListHeight(null);
    try {
      localStorage.removeItem(HISTORY_LIST_HEIGHT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!historyResizing) return;
    const onMove = (e: PointerEvent) => {
      const drag = historyResizeDragRef.current;
      if (!drag) return;
      // The commit list sits above the detail: dragging down grows it.
      setHistoryListHeight(
        Math.min(HISTORY_LIST_HEIGHT_MAX, Math.max(HISTORY_LIST_HEIGHT_MIN, drag.startHeight + (e.clientY - drag.startY))),
      );
    };
    const onUp = () => {
      historyResizeDragRef.current = null;
      setHistoryResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [historyResizing]);

  useEffect(() => {
    if (historyListHeight === null) return;
    try {
      localStorage.setItem(HISTORY_LIST_HEIGHT_KEY, String(historyListHeight));
    } catch {
      /* ignore */
    }
  }, [historyListHeight]);

  useEffect(() => {
    if (!historyResizing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "row-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [historyResizing]);

  useEffect(() => {
    if (!navResizing) return;
    const onMove = (e: PointerEvent) => {
      const drag = navResizeDragRef.current;
      if (!drag) return;
      // The navigator sits on the right of the stage: dragging left widens it.
      const max = Math.max(GIT_NAVIGATOR_MIN_WIDTH, panelWidth - GIT_STAGE_MIN_WIDTH);
      setDraggedNavigatorWidth(
        Math.min(max, Math.max(GIT_NAVIGATOR_MIN_WIDTH, drag.startWidth - (e.clientX - drag.startX))),
      );
    };
    const onUp = () => {
      navResizeDragRef.current = null;
      setNavResizing(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [navResizing, panelWidth]);

  useEffect(() => {
    if (!navResizing) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    document.body.classList.add(styles.resizingBody);
    return () => {
      document.body.style.cursor = prev;
      document.body.classList.remove(styles.resizingBody);
    };
  }, [navResizing]);

  useEffect(() => {
    try {
      localStorage.setItem(CHANGES_VIEW_KEY, view);
    } catch {
      /* ignore */
    }
  }, [view]);

  useEffect(() => {
    const page = panelRef.current?.parentElement;
    if (!page || !open) return;
    const sync = () => setPageWidth(page.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(page);
    return () => observer.disconnect();
  }, [open]);

  /**
   * Dropping the stored width drops the memory of it too: the next session opens
   * at the default instead of at the width the reader was last unhappy with.
   */
  const resetPanelWidth = useCallback(() => {
    setDraggedWidth(null);
    try {
      localStorage.removeItem(PANEL_WIDTH_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const gitErrorToast = useCallback(
    (e: unknown, fallback: string, context?: "checkout" | "sync") => {
      const raw = e instanceof Error ? e.message : "";
      showToast(formatGitErrorToast(raw, t, { context, fallback }), { tone: "danger" });
    },
    [t],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.gitStatus(sessionId);
      onStatusChange(next);
      return next;
    } catch {
      return null;
    }
  }, [onStatusChange, sessionId]);

  const refreshCommits = useCallback(async () => {
    setLoadingCommits(true);
    try {
      const { commits: next, outgoing: nextOutgoing } = await api.gitLog(sessionId, 60);
      setCommits(next);
      setOutgoing(nextOutgoing ?? []);
      return next;
    } catch {
      setCommits([]);
      setOutgoing([]);
      return [];
    } finally {
      setLoadingCommits(false);
    }
  }, [sessionId]);

  const selectCommit = useCallback(
    async (hash: string, opts?: { keepChangesTab?: boolean }) => {
      setSelection({ kind: "commit", hash, filePath: null });
      if (!opts?.keepChangesTab) setTab("history");
      setLoadingCommitDetail(true);
      try {
        const { detail } = await api.gitCommitDetail(sessionId, hash);
        setCommitDetail(detail);
      } catch (e) {
        setCommitDetail(null);
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        setLoadingCommitDetail(false);
      }
    },
    [sessionId],
  );

  const reloadHistorySelection = useCallback(async () => {
    if (selection.kind !== "commit") return;
    setLoadingCommitDetail(true);
    try {
      const { detail } = await api.gitCommitDetail(sessionId, selection.hash);
      setCommitDetail(detail);
    } catch {
      setCommitDetail(null);
    } finally {
      setLoadingCommitDetail(false);
    }
  }, [selection, sessionId]);

  const handleCheckout = useCallback(
    async (branch: string, create?: boolean) => {
      await onCheckout(branch, create);
      setSelection({ kind: "working", path: null });
      setBlame(null);
      setCommitDetail(null);
      await refreshCommits();
    },
    [onCheckout, refreshCommits],
  );

  useEffect(() => {
    setCommits([]);
    setCommitDetail(null);
    setSelection({ kind: "working", path: null });
    setBlame(null);
    setTab("changes");
    setCommitSummary("");
    setCommitDescription("");
    setLoadingCommits(false);
    setLoadingCommitDetail(false);
    setNavigatorOpen(false);
    setOpsAnchor(null);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    setSelection({ kind: "working", path: null });
    setBlame(null);
    // The panel is hidden, not unmounted: close/reopen starts on the board, not
    // on the sheet or the full view the reader left behind.
    setNavigatorOpen(false);
    void refreshStatus().then(() => {
      void refreshCommits();
    });
  }, [open, refreshStatus, refreshCommits]);

  useEffect(() => {
    if (!opsAnchor) return;
    const close = () => setOpsAnchor(null);
    const onPointerDown = (e: Event) => {
      if (opsMenuRef.current?.contains(e.target as Node)) return;
      if (opsRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [opsAnchor]);

  /** Hover intent for the "…" menu: leaving the button or menu closes after a grace. */
  const cancelOpsHoverClose = useCallback(() => {
    if (opsHoverTimerRef.current !== null) {
      window.clearTimeout(opsHoverTimerRef.current);
      opsHoverTimerRef.current = null;
    }
  }, []);

  const scheduleOpsHoverClose = useCallback(() => {
    cancelOpsHoverClose();
    opsHoverTimerRef.current = window.setTimeout(() => setOpsAnchor(null), 260);
  }, [cancelOpsHoverClose]);

  /**
   * The toolbar keeps every action reachable: whatever the row cannot hold goes
   * behind the "…" button. The leading controls (stepper, list/tree switch) are
   * measured as one block, and the buttons are counted against what is left —
   * always reserving room for the "…" button itself unless all of them fit.
   */
  useLayoutEffect(() => {
    const root = toolsEl;
    const lead = toolsLeadEl;
    if (!root || !lead) return;
    const total = 6;
    const measure = () => {
      const cs = getComputedStyle(root);
      // jsdom (and odd layouts) can return "" here: treat unparsable padding as 0.
      const pad = (v: string) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      };
      const inner = root.clientWidth - pad(cs.paddingLeft) - pad(cs.paddingRight);
      // Zero width = the row is not laid out yet (or hidden): measuring against
      // it would fold every button into the menu on a guess. The observer fires
      // again once a real width exists.
      if (inner <= 0) return;
      const budget = inner - lead.offsetWidth - TOOL_ROW_GAP;
      if (budget >= total * TOOL_BUTTON_STEP) {
        setVisibleActions(total);
        return;
      }
      const withMenu = Math.floor((budget - (TOOL_BUTTON_STEP + TOOL_ROW_GAP)) / TOOL_BUTTON_STEP);
      setVisibleActions(Math.max(0, Math.min(total - 1, withMenu)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [toolsEl, toolsLeadEl, tab]);

  useEffect(() => {
    if (!navigatorOpen) return;
    // Capture, so the stage's own Escape handling does not close the whole
    // panel from under the sheet the reader is looking at.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setNavigatorOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigatorOpen]);

  useEffect(() => {
    if (!fullscreen) return;
    // Same rule as the sheet: Escape unwinds the innermost layer, so the full
    // view goes back to the board instead of taking the whole panel with it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onFullscreenChange(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [fullscreen, onFullscreenChange]);

  /**
   * Selecting a file is what feeds the stage; selecting it again empties it.
   * On a phone the sheet gets out of the way: the diff is what was asked for.
   */
  const showFile = useCallback(
    (next: Selection) => {
      setBlame(null);
      setSelection(next);
      setJumpToken((token) => token + 1);
      if (sheetNavigator && (next.kind === "working" ? next.path : next.filePath)) {
        setNavigatorOpen(false);
      }
    },
    [sheetNavigator],
  );

  const toggleWorkingFile = useCallback(
    (path: string) => {
      showFile(
        selection.kind === "working" && selection.path === path
          ? { kind: "working", path: null }
          : { kind: "working", path },
      );
    },
    [selection, showFile],
  );

  /** Jump to the previous/next changed file, GitHub Desktop style. */
  const stepFile = useCallback(
    (delta: number) => {
      const paths = (status?.files ?? []).map((f) => f.path);
      if (paths.length === 0) return;
      const current = selection.kind === "working" ? paths.indexOf(selection.path ?? "") : -1;
      const next = current < 0 ? 0 : Math.min(paths.length - 1, Math.max(0, current + delta));
      showFile({ kind: "working", path: paths[next]! });
    },
    [status, selection, showFile],
  );

  const toggleCommitFile = useCallback(
    (hash: string, filePath: string) => {
      showFile(
        selection.kind === "commit" && selection.hash === hash && selection.filePath === filePath
          ? { kind: "commit", hash, filePath: null }
          : { kind: "commit", hash, filePath },
      );
    },
    [selection, showFile],
  );

  const setFilesStage = useCallback(
    async (paths: string[], staged: boolean) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitStage(sessionId, paths, staged);
        onStatusChange(result.status);
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [onStatusChange, sessionId],
  );

  /** After a file is discarded or deleted, the stage must stop showing it. */
  const refreshAfterFileMutation = useCallback(
    async (nextStatus: GitStatusDto) => {
      onStatusChange(nextStatus);
      setSelection((prev) =>
        prev.kind === "working" && prev.path && !nextStatus.files.some((f) => f.path === prev.path)
          ? { kind: "working", path: null }
          : prev,
      );
    },
    [onStatusChange],
  );

  const discardPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitDiscard(sessionId, paths);
        await refreshAfterFileMutation(result.status);
        showToast(t("git.discardOk"), { tone: "success" });
      } catch (e) {
        gitErrorToast(e, t("git.syncFailed"));
      } finally {
        setBusy(false);
      }
    },
    [refreshAfterFileMutation, sessionId, t],
  );

  const deletePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitDelete(sessionId, paths);
        await refreshAfterFileMutation(result.status);
        showToast(t("git.deleteOk"), { tone: "success" });
      } catch (e) {
        gitErrorToast(e, t("git.syncFailed"));
      } finally {
        setBusy(false);
      }
    },
    [refreshAfterFileMutation, sessionId, t],
  );

  const ignorePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitIgnore(sessionId, paths);
        await refreshAfterFileMutation(result.status);
        showToast(result.added.length > 0 ? t("git.gitIgnoreOk") : t("git.gitIgnoreNone"), {
          tone: result.added.length > 0 ? "success" : "info",
        });
      } catch (e) {
        gitErrorToast(e, t("git.gitIgnoreFailed"));
      } finally {
        setBusy(false);
      }
    },
    [refreshAfterFileMutation, sessionId, t],
  );

  const loadWorkingBlame = useCallback(
    async (path: string) => {
      try {
        const result = await api.gitBlame(sessionId, path);
        setBlame({ path, text: result.blame });
        setSelection({ kind: "working", path });
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
      }
    },
    [sessionId],
  );

  const stageAll = async () => {
    const paths = (status?.files ?? []).filter((f) => f.unstaged).map((f) => f.path);
    await setFilesStage(paths, true);
  };

  const unstageAll = async () => {
    const paths = (status?.files ?? []).filter((f) => f.staged).map((f) => f.path);
    await setFilesStage(paths, false);
  };

  const buildCommitMessage = () => {
    const summary = commitSummary.trim();
    const description = commitDescription.trim();
    if (!summary) return "";
    return description ? `${summary}\n\n${description}` : summary;
  };

  const focusConflictFiles = useCallback((nextStatus: GitStatusDto) => {
    const conflicts = gitConflictFiles(nextStatus);
    if (conflicts.length === 0) return;
    setTab("changes");
    setSelection({ kind: "working", path: conflicts[0]!.path });
  }, []);

  /** Sync moves HEAD: refresh the commit list and whatever commit sits on the stage. */
  const refreshAfterSync = useCallback(async () => {
    try {
      if (selection.kind === "commit") await reloadHistorySelection();
      await refreshCommits();
    } catch {
      /* sync already succeeded — don't surface secondary refresh errors as a failed push */
    }
  }, [refreshCommits, reloadHistorySelection, selection]);

  /**
   * Manual refresh: re-read status, history, and — when a commit sits on the
   * stage — its detail. The button turns until all three settle. The background
   * poll already keeps these fresh, so on its own the click would show nothing;
   * the spinner is the acknowledgement, and `REFRESH_MIN_VISIBLE_MS` keeps it
   * above the flicker threshold.
   */
  const runManualRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const settle = () => {
      refreshingRef.current = false;
      setRefreshing(false);
    };
    const startedAt = Date.now();
    try {
      setReloadToken((token) => token + 1);
      await refreshStatus();
      await refreshCommits();
      if (selection.kind === "commit") await reloadHistorySelection();
    } finally {
      const remaining = REFRESH_MIN_VISIBLE_MS - (Date.now() - startedAt);
      if (remaining > 0) window.setTimeout(settle, remaining);
      else settle();
    }
  }, [refreshCommits, refreshStatus, reloadHistorySelection, selection]);

  const runSync = async (action: "fetch" | "pull" | "push") => {
    if (syncInFlightRef.current || busy) return;
    syncInFlightRef.current = true;
    setBusy(true);
    try {
      const result = await api.gitSync(sessionId, action);
      onStatusChange(result.status);
      if (result.conflict) {
        const conflicts = gitConflictFiles(result.status);
        showToast(gitPullConflictMessage(conflicts.length, t), { tone: "danger" });
        focusConflictFiles(result.status);
      } else {
        showToast(gitSyncSuccessMessage(action, result.output, t), { tone: "success" });
        await refreshAfterSync();
      }
    } catch (e) {
      gitErrorToast(e, t("git.syncFailed"));
    } finally {
      syncInFlightRef.current = false;
      setBusy(false);
    }
  };

  const runStash = async (action: "push" | "pop") => {
    setBusy(true);
    try {
      const result = await api.gitStash(sessionId, action);
      onStatusChange(result.status);
      showToast(action === "push" ? t("git.stashOk") : t("git.popOk"), { tone: "success" });
      if (selection.kind === "commit") await reloadHistorySelection();
      await refreshCommits();
    } catch (e) {
      gitErrorToast(e, t("git.syncFailed"));
    } finally {
      setBusy(false);
    }
  };

  const runCommitAction = async (action: "revert" | "cherry-pick", hash: string) => {
    setBusy(true);
    try {
      const result = await api.gitCommitAction(sessionId, action, hash);
      onStatusChange(result.status);
      showToast(action === "revert" ? t("git.revertOk") : t("git.cherryPickOk"), { tone: "success" });
      const nextCommits = await refreshCommits();
      setTab("history");
      const nextHash = nextCommits[0]?.hash ?? hash;
      setSelection({ kind: "commit", hash: nextHash, filePath: null });
      if (nextCommits[0]) void selectCommit(nextCommits[0].hash);
      else if (result.status.dirty) {
        setTab("changes");
        setSelection({ kind: "working", path: null });
      }
    } catch (e) {
      gitErrorToast(e, t("git.syncFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createBranchAt = async (hash: string, branch: string) => {
    setBusy(true);
    try {
      const result = await api.gitCreateBranchAt(sessionId, hash, branch);
      onStatusChange(result.status);
      showToast(t("git.createBranchHereOk"), { tone: "success" });
      await refreshCommits();
    } catch (e) {
      gitErrorToast(e, t("git.syncFailed"));
    } finally {
      setBusy(false);
    }
  };

  const createTagAt = async (hash: string, tag: string) => {
    setBusy(true);
    try {
      const result = await api.gitCreateTagAt(sessionId, hash, tag);
      onStatusChange(result.status);
      showToast(t("git.createTagHereOk"), { tone: "success" });
      await refreshCommits();
    } catch (e) {
      gitErrorToast(e, t("git.syncFailed"));
    } finally {
      setBusy(false);
    }
  };

  const checkoutCommit = async (hash: string) => {
    if (
      !window.confirm(t("git.checkoutCommitConfirm", { hash: hash.slice(0, 7) }))
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await api.gitCheckoutRev(sessionId, hash);
      onStatusChange(result.status);
      showToast(t("git.checkoutOk"), { tone: "success" });
      setTab("history");
      setSelection({ kind: "commit", hash, filePath: null });
      setCommitDetail(null);
      const nextCommits = await refreshCommits();
      if (nextCommits.some((c) => c.hash === hash)) {
        await selectCommit(hash);
      }
    } catch (e) {
      gitErrorToast(e, t("git.checkoutFailed"), "checkout");
    } finally {
      setBusy(false);
    }
  };

  const applyCommitSuccess = async (status: GitStatusDto) => {
    onStatusChange(status);
    setCommitSummary("");
    setCommitDescription("");
    setSelection({ kind: "working", path: null });
    setBlame(null);
    if (status.dirty) setTab("changes");
    await refreshCommits();
  };

  const onCommit = async (e: FormEvent) => {
    e.preventDefault();
    const message = buildCommitMessage();
    if (!message) return;
    setBusy(true);
    try {
      const result = await api.gitCommit(sessionId, message);
      await applyCommitSuccess(result.status);
      showToast(t("git.commitOk"), { tone: "success" });
    } catch (err) {
      gitErrorToast(err, t("git.commitFailed"));
    } finally {
      setBusy(false);
    }
  };

  const onCommitAndPush = async () => {
    const message = buildCommitMessage();
    if (!message || syncInFlightRef.current || busy) return;
    syncInFlightRef.current = true;
    setBusy(true);
    try {
      const result = await api.gitCommit(sessionId, message);
      await applyCommitSuccess(result.status);
      try {
        const syncResult = await api.gitSync(sessionId, "push");
        onStatusChange(syncResult.status);
        showToast(gitSyncSuccessMessage("push", syncResult.output, t), { tone: "success" });
        await refreshAfterSync();
      } catch (err) {
        gitErrorToast(err, t("git.syncFailed"));
      }
    } catch (err) {
      gitErrorToast(err, t("git.commitFailed"));
    } finally {
      syncInFlightRef.current = false;
      setBusy(false);
    }
  };

  if (!open) return null;

  const repoPending = statusLoading || (awaitingGit && !status);
  const files = status?.files ?? [];
  const repo = status?.repo ?? false;
  const conflictFiles = files.filter(isGitConflictFile);
  const stagedFiles = files.filter((f) => f.staged && !isGitConflictFile(f));
  const unstagedFiles = files.filter((f) => f.unstaged && !isGitConflictFile(f));
  const workingSelected = selection.kind === "working";
  const commitSelected = selection.kind === "commit";

  const stageFiles: GitDiffFile[] = commitSelected
    ? (commitDetail?.files ?? []).map((file) => ({
        path: normalizeGitPath(file.path),
        badge: COMMIT_FILE_BADGE[file.status],
        additions: file.additions,
        deletions: file.deletions,
      }))
    : files.map((file) => ({
        path: normalizeGitPath(file.path),
        badge: gitStatusBadge(file),
        additions: file.additions,
        deletions: file.deletions,
        untracked: isUntrackedGitFile(file),
      }));
  /** The stage shows one file at a time; nothing selected means it starts at the top. */
  const stagePath = commitSelected ? selection.filePath : selection.path;
  const stageScope: GitDiffScope =
    commitSelected && selection.hash
      ? { mode: "commit", rev: selection.hash }
      : { mode: "working" };

  const commitPaneProps = {
    files,
    conflictFiles,
    stagedFiles,
    unstagedFiles,
    view,
    stagedCount: status?.stagedCount ?? 0,
    busy,
    workingSelected,
    selectionPath: workingSelected ? selection.path : null,
    commitSummary,
    commitDescription,
    onSummaryChange: setCommitSummary,
    onDescriptionChange: setCommitDescription,
    onStageAll: () => void stageAll(),
    onUnstageAll: () => void unstageAll(),
    onStagePaths: (paths: string[], staged: boolean) => void setFilesStage(paths, staged),
    onSelectFile: toggleWorkingFile,
    onCommit: (e: FormEvent) => void onCommit(e),
    onCommitAndPush: () => void onCommitAndPush(),
    onStageAndCommit: () => void stageAll(),
    repoRoot: status?.root,
    onDiscardPaths: discardPaths,
    onDeletePaths: deletePaths,
    onIgnorePaths: ignorePaths,
    onBlameFile: loadWorkingBlame,
    outgoing,
    outgoingLoading: loadingCommitDetail,
    commitHash: commitSelected ? selection.hash : null,
    commitFilePath: commitSelected ? selection.filePath : null,
    outgoingFiles:
      commitSelected && commitDetail?.hash === selection.hash ? commitDetail.files : [],
    onInspectOutgoing: (hash: string) => void selectCommit(hash, { keepChangesTab: true }),
    onSelectOutgoingFile: (hash: string, path: string) => toggleCommitFile(hash, path),
  };

  /**
   * One tree of markup for both places the navigator lives: a column beside the
   * stage on a wide panel, the content of a bottom sheet on a phone. Only one of
   * the two is mounted at a time, so the tab and the lists need no syncing.
   */
  const toolActions: GitToolAction[] = [
    {
      id: "refresh",
      title: t("common.refresh"),
      disabled: busy || refreshing,
      run: () => void runManualRefresh(),
      icon: (
        <span className={refreshing ? styles.iconSpin : undefined}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ),
    },
    {
      id: "pull",
      title: t("git.pull"),
      disabled: busy,
      run: () => void runSync("pull"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 4v11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path
            d="M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "push",
      title: t("git.push"),
      disabled: busy,
      run: () => void runSync("push"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 20V9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path
            d="M7.5 13.5 12 9l4.5 4.5M5.5 4.5h13"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "fetch",
      title: t("git.fetch"),
      disabled: busy,
      run: () => void runSync("fetch"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 11.5a8 8 0 0 0-14.6-4.2M4 12.5a8 8 0 0 0 14.6 4.2M20 3.5v4h-4M4 20.5v-4h4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "stash",
      title: t("git.stash"),
      disabled: busy || !status?.dirty,
      run: () => void runStash("push"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 3.5v7.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path
            d="M8.5 7.5 12 11l3.5-3.5M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5M4 13h16"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      id: "pop",
      title: t("git.pop"),
      disabled: busy || !(status?.stashCount ?? 0),
      run: () => void runStash("pop"),
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 20.5V13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path
            d="M8.5 16.5 12 13l3.5 3.5M5 11V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5M4 11h16"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
  ];
  const hiddenActions = toolActions.slice(Math.max(0, visibleActions));

  const toggleOpsMenu = () => {
    if (opsAnchor) {
      setOpsAnchor(null);
      return;
    }
    const btn = opsRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - OPS_MENU_WIDTH - 8));
    // The toolbar sits near the top of the panel, so opening upward — the menu's
    // natural direction — would clip it against the top edge. Flip below when
    // the items do not fit above the button.
    const estimatedHeight = hiddenActions.length * 38 + 12;
    const fitsAbove = rect.top >= estimatedHeight + 12;
    setOpsAnchor({
      left,
      ...(fitsAbove
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: Math.min(rect.bottom + 6, window.innerHeight - estimatedHeight - 8) }),
    });
  };

  const navigatorInner = (
    <div className={styles.navigator}>
      <header className={styles.navHead}>
        <div className={styles.navHeadTop}>
          <span className={styles.navChangeCaption}>
            {t("git.changedOn", { count: files.length })}
          </span>
          <span className={styles.navStats}>
            {status?.dirty ? (
              <>
                <span className={styles.statAdd}>+{status.additions}</span>
                <span className={styles.statDel}>-{status.deletions}</span>
              </>
            ) : (
              <span className={styles.navClean}>{t("git.noChanges")}</span>
            )}
          </span>
          {status?.repo ? (
            <div className={styles.navBranch}>
              <GitBranchSwitcher
                status={status}
                branchBusy={branchBusy}
                onCheckout={handleCheckout}
                onDeleteBranch={onDeleteBranch}
                variant="panelHeader"
              />
            </div>
          ) : (
            <span className={styles.navTitle}>{t("git.title")}</span>
          )}
          {sheetNavigator ? null : (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onClose}
              title={t("git.closeChanges")}
              aria-label={t("git.closeChanges")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <div className={styles.navTabRow}>
          <div className={styles.tabSwitch} role="tablist" aria-label={t("git.title")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "changes"}
              className={`${styles.tabSwitchBtn}${tab === "changes" ? ` ${styles.tabSwitchBtnActive}` : ""}`}
              title={t("git.tabChanges")}
              onClick={() => setTab("changes")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {t("git.tabChanges")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "history"}
              className={`${styles.tabSwitchBtn}${tab === "history" ? ` ${styles.tabSwitchBtnActive}` : ""}`}
              title={t("git.tabHistory")}
              onClick={() => setTab("history")}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {t("git.tabHistory")}
            </button>
          </div>
        </div>
      </header>

      <div className={styles.navTools} role="toolbar" aria-label={t("git.title")} ref={setToolsEl}>
        <div className={styles.navToolsLead} ref={setToolsLeadEl}>
          {tab === "changes" ? (
            <>
              <div className={styles.navStep}>
                <button
                  type="button"
                  className={styles.segBtn}
                  disabled={files.length === 0}
                  title={t("git.diffStagePrev")}
                  aria-label={t("git.diffStagePrev")}
                  onClick={() => stepFile(-1)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={styles.segBtn}
                  disabled={files.length === 0}
                  title={t("git.diffStageNext")}
                  aria-label={t("git.diffStageNext")}
                  onClick={() => stepFile(1)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
              <div className={styles.segSwitch}>
                <button
                  type="button"
                  className={`${styles.segBtn}${view === "list" ? ` ${styles.segBtnActive}` : ""}`}
                  aria-pressed={view === "list"}
                  aria-label={t("git.fileViewList")}
                  title={t("git.fileViewList")}
                  onClick={() => setView("list")}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`${styles.segBtn}${view === "tree" ? ` ${styles.segBtnActive}` : ""}`}
                  aria-pressed={view === "tree"}
                  aria-label={t("git.fileViewTree")}
                  title={t("git.fileViewTree")}
                  onClick={() => setView("tree")}
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
            </>
          ) : null}
        </div>
        <div className={styles.navToolsActions}>
          {toolActions.slice(0, Math.max(0, visibleActions)).map((action) => (
            <button
              key={action.id}
              type="button"
              className={styles.iconBtn}
              disabled={action.disabled}
              aria-busy={action.id === "refresh" ? refreshing : undefined}
              onClick={action.run}
              title={action.title}
              aria-label={action.title}
            >
              {action.icon}
            </button>
          ))}
          {hiddenActions.length > 0 ? (
            <button
              ref={opsRef}
              type="button"
              className={styles.iconBtn}
              aria-haspopup="menu"
              aria-expanded={Boolean(opsAnchor)}
              title={t("common.more")}
              aria-label={t("common.more")}
              onClick={toggleOpsMenu}
              onMouseEnter={() => {
                cancelOpsHoverClose();
                if (!opsAnchor) toggleOpsMenu();
              }}
              onMouseLeave={scheduleOpsHoverClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="5" cy="12" r="1.7" fill="currentColor" />
                <circle cx="12" cy="12" r="1.7" fill="currentColor" />
                <circle cx="19" cy="12" r="1.7" fill="currentColor" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {opsAnchor && hiddenActions.length > 0
        ? createPortal(
            /* Fixed positioning inside the phone sheet would be measured against
               the sheet's own transform, not the viewport: portal it out. */
            <div
              ref={opsMenuRef}
              className={styles.footMenu}
              role="menu"
              style={{ left: opsAnchor.left, top: opsAnchor.top, bottom: opsAnchor.bottom }}
              onMouseEnter={cancelOpsHoverClose}
              onMouseLeave={scheduleOpsHoverClose}
            >
              {hiddenActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  disabled={action.disabled}
                  onClick={() => {
                    setOpsAnchor(null);
                    action.run();
                  }}
                >
                  {action.title}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      <div className={styles.navBody}>
        {tab === "changes" ? (
          <GitChangesCommitPane {...commitPaneProps} />
        ) : (
          <>
            <div
              className={styles.historyList}
              style={
                historyListHeight !== null
                  ? ({ flex: "0 0 auto", height: `${historyListHeight}px` } as CSSProperties)
                  : undefined
              }
            >
              <GitCommitHistory
                commits={commits}
                status={status}
                loading={loadingCommits}
                busy={busy}
                selectedHash={commitSelected ? selection.hash : null}
                wipSelected={workingSelected && Boolean(status?.dirty)}
                onSelectCommit={(hash) => void selectCommit(hash)}
                onSelectWip={() => {
                  setTab("history");
                  setSelection({ kind: "working", path: null });
                  setBlame(null);
                  setCommitDetail(null);
                }}
                onRevertCommit={(hash) => void runCommitAction("revert", hash)}
                onCherryPickCommit={(hash) => void runCommitAction("cherry-pick", hash)}
                onCreateBranchAt={(hash, branch) => void createBranchAt(hash, branch)}
                onCreateTagAt={(hash, tag) => void createTagAt(hash, tag)}
                onCheckoutCommit={(hash) => void checkoutCommit(hash)}
              />
            </div>
            <div
              className={styles.historyListSplitter}
              onPointerDown={onHistorySplitterDown}
              onDoubleClick={resetHistoryListHeight}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("git.resizeHistoryDetail")}
              title={t("git.resizeHistoryDetail")}
            />
            <div className={styles.historyDetail}>
              <GitCommitDetail
                loading={loadingCommitDetail}
                detail={commitSelected ? commitDetail : null}
                repoRoot={status?.root}
                wipFiles={workingSelected && status?.dirty ? files : undefined}
                selectedFilePath={commitSelected ? selection.filePath : selection.path}
                onSelectFile={(path) => {
                  if (commitSelected) toggleCommitFile(selection.hash, path);
                  else toggleWorkingFile(path);
                }}
                onSelectParent={(hash) => void selectCommit(hash)}
                onBlameFile={loadWorkingBlame}
                wipMode={workingSelected && Boolean(status?.dirty)}
              />
            </div>
          </>
        )}
      </div>

    </div>
  );

  const stageSlot = blame ? (
    <GitBlameView path={blame.path} text={blame.text} onClose={() => setBlame(null)} />
  ) : (
    <GitDiffStage
      sessionId={sessionId}
      scope={stageScope}
      files={stageFiles}
      initialPath={stagePath}
      jumpToken={jumpToken}
      reloadToken={reloadToken}
      compact={sheetNavigator && !fullscreen}
      expanded={fullscreen}
      flushTop={fullscreen || takeover}
      onToggleExpand={() => onFullscreenChange(!fullscreen)}
      onClose={sheetNavigator && !fullscreen ? onClose : undefined}
    />
  );

  const panelClasses = [
    styles.panel,
    overlay && styles.panelOverlay,
    takeover && styles.panelTakeover,
    sheetNavigator && styles.panelSheetNav,
    fullscreen && styles.panelFullscreen,
    resizing && styles.resizing,
  ]
    .filter(Boolean)
    .join(" ");

  const panel = (
    <aside
      ref={panelRef}
      className={panelClasses}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? t("git.diffFullscreenOpen") : t("git.title")}
      style={
        {
          ["--git-panel-width" as string]: `${panelWidth}px`,
          ["--git-navigator-width" as string]: `${navigatorWidth}px`,
        } as CSSProperties
      }
    >
      {!overlay && !fullscreen ? (
        <div
          className={styles.splitter}
          onPointerDown={onSplitterDown}
          onDoubleClick={resetPanelWidth}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeChanges")}
          aria-valuenow={panelWidth}
          aria-valuemin={GIT_PANEL_WIDTH_MIN}
          aria-valuemax={GIT_PANEL_WIDTH_MAX}
          title={t("common.resizeChangesHint")}
        />
      ) : null}
      {repoPending ? (
        <>
          {/* A takeover covers the shell header: its own bar carries the way back. */}
          {takeover ? (
            <GitStageHeader title={t("git.title")} flushTop onBack={onClose} />
          ) : null}
          <div className={`${styles.empty} ${styles.emptyLoading}`}>
            <span className={styles.loaderSpin} aria-hidden />
            {t("git.initializing")}
          </div>
        </>
      ) : !status?.repo ? (
        <>
          {takeover ? (
            <GitStageHeader title={t("git.title")} flushTop onBack={onClose} />
          ) : null}
          <div className={styles.empty}>{t("git.noRepo")}</div>
        </>
      ) : (
        <>
          <div className={styles.stageHost}>{stageSlot}</div>
          {fullscreen || sheetNavigator ? null : (
            <div
              className={styles.navSplitter}
              onPointerDown={onNavigatorSplitterDown}
              onDoubleClick={resetNavigatorWidth}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("common.resizeChanges")}
              aria-valuenow={navigatorWidth}
              aria-valuemin={GIT_NAVIGATOR_MIN_WIDTH}
              title={t("common.resizeChangesHint")}
            />
          )}
          {fullscreen ? null : sheetNavigator ? (            <>
              <button
                type="button"
                className={styles.puller}
                onClick={() => setNavigatorOpen(true)}
                aria-expanded={navigatorOpen}
                aria-label={t("git.openChanges")}
              >
                <span className={styles.pullerBar} aria-hidden />
                <span className={styles.pullerTitle}>
                  {tab === "changes" ? t("git.tabChanges") : t("git.tabHistory")}
                </span>
                <span className={styles.pullerMeta}>
                  {status.dirty ? (
                    <>
                      <span>{t("git.changedFiles", { count: files.length })}</span>
                      <span className={styles.statAdd}>+{status.additions}</span>
                      <span className={styles.statDel}>-{status.deletions}</span>
                    </>
                  ) : (
                    <span>{t("git.noChanges")}</span>
                  )}
                </span>
                <svg
                  className={`${styles.pullerChevron}${navigatorOpen ? ` ${styles.pullerChevronUp}` : ""}`}
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M6 15l6-6 6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {navigatorOpen ? (
                <>
                  <div className={styles.sheetBackdrop} onClick={() => setNavigatorOpen(false)} aria-hidden />
                  <div className={styles.sheet} role="dialog" aria-label={t("git.openChanges")}>
                    <button
                      type="button"
                      className={styles.sheetGrabber}
                      onClick={() => setNavigatorOpen(false)}
                      aria-label={t("git.closeChanges")}
                    >
                      <span aria-hidden />
                    </button>
                    {navigatorInner}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            navigatorInner
          )}
        </>
      )}
    </aside>
  );

  /**
   * The full view and the phone takeover are the whole screen, not a wider dock —
   * portalled to the body so no page container (or its `container-type`) can clip
   * them, and no ancestor stacking context can hold them under the shell header.
   */
  return fullscreen || takeover ? createPortal(panel, document.body) : panel;
}
