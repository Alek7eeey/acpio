import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
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
  GIT_PANEL_WIDTH_MAX,
  GIT_PANEL_WIDTH_MIN,
  GIT_SPLIT_MIN_WIDTH,
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
  const [opsAnchor, setOpsAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const opsRef = useRef<HTMLButtonElement | null>(null);
  const opsMenuRef = useRef<HTMLDivElement | null>(null);
  /** List or tree: the commit pane's file rows, switched from the navigator header. */
  const [view, setView] = useState<ChangesView>(readChangesView);
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

  useEffect(() => {
    if (draggedWidth === null) return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(draggedWidth));
    } catch {
      /* ignore */
    }
  }, [draggedWidth]);

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
  const navigatorWidth = gitNavigatorWidthFor(panelWidth);
  const sheetNavigator = panelWidth < GIT_SPLIT_MIN_WIDTH;

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
  const navigatorInner = (
    <div className={styles.navigator}>
      <header className={styles.navHead}>
        <div className={styles.navHeadTop}>
          <span className={styles.navRepoIcon} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="6.5" cy="6.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="17.5" cy="17.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M8.5 6.5h5.2a3 3 0 0 1 3 3v2.2M8.5 17.5V11a3 3 0 0 1 3-3h2.2"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div className={styles.navLead}>
            {status?.repo ? (
              <GitBranchSwitcher
                status={status}
                branchBusy={branchBusy}
                onCheckout={handleCheckout}
                onDeleteBranch={onDeleteBranch}
                variant="panelHeader"
              />
            ) : (
              <span className={styles.navTitle}>{t("git.title")}</span>
            )}
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
          </div>
          <div className={styles.navIcons}>
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
        </div>

        {status && (status.conflict || status.stagedCount > 0 || status.unstagedCount > 0) ? (
          <div className={styles.navPills}>
            {status.conflict ? (
              <span className={`${styles.countPill} ${styles.countPillConflict}`}>
                {t("git.conflictCount", { count: conflictFiles.length })}
              </span>
            ) : null}
            {status.stagedCount > 0 ? (
              <span className={`${styles.countPill} ${styles.countPillStaged}`}>
                {t("git.stagedCount", { count: status.stagedCount })}
              </span>
            ) : null}
            {status.unstagedCount > 0 ? (
              <span className={`${styles.countPill} ${styles.countPillUnstaged}`}>
                {t("git.unstagedCount", { count: status.unstagedCount })}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className={styles.navBody}>
        {tab === "changes" ? (
          <GitChangesCommitPane {...commitPaneProps} />
        ) : (
          <>
            <div className={styles.historyList}>
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

      <div className={styles.navFoot} role="toolbar" aria-label={t("git.title")}>
        <div className={styles.segSwitch} role="tablist" aria-label={t("git.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "changes"}
            className={`${styles.segBtn}${tab === "changes" ? ` ${styles.segBtnActive}` : ""}`}
            title={t("git.tabChanges")}
            aria-label={t("git.tabChanges")}
            onClick={() => setTab("changes")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`${styles.segBtn}${tab === "history" ? ` ${styles.segBtnActive}` : ""}`}
            title={t("git.tabHistory")}
            aria-label={t("git.tabHistory")}
            onClick={() => setTab("history")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {tab === "changes" ? (
          <div className={styles.segSwitch} role="toolbar" aria-label={t("git.fileViewMode")}>
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
        ) : null}
        <span className={styles.actionDivider} aria-hidden />
        <button
          type="button"
          className={styles.iconBtn}
          disabled={busy || refreshing}
          aria-busy={refreshing}
          onClick={() => void runManualRefresh()}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <span className={refreshing ? styles.iconSpin : undefined}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          disabled={busy}
          onClick={() => void runSync("pull")}
          title={t("git.pull")}
          aria-label={t("git.pull")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M8 11l4 4 4-4M6 19h12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          disabled={busy}
          onClick={() => void runSync("push")}
          title={t("git.push")}
          aria-label={t("git.push")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 19V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M8 13l4-4 4 4M6 5h12"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          ref={opsRef}
          className={styles.iconBtn}
          aria-haspopup="menu"
          aria-expanded={Boolean(opsAnchor)}
          aria-label={t("common.more")}
          title={t("common.more")}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpsAnchor(
              opsAnchor
                ? null
                : {
                    left: Math.max(8, Math.min(rect.left, window.innerWidth - OPS_MENU_WIDTH - 8)),
                    bottom: Math.max(8, window.innerHeight - rect.top + 6),
                  },
            );
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="5" cy="12" r="1.7" fill="currentColor" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" />
            <circle cx="19" cy="12" r="1.7" fill="currentColor" />
          </svg>
        </button>
      </div>

      {opsAnchor ? (
        <div
          ref={opsMenuRef}
          className={styles.footMenu}
          style={{ left: opsAnchor.left, bottom: opsAnchor.bottom }}
          role="menu"
          aria-label={t("common.actions")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpsAnchor(null);
              void runSync("fetch");
            }}
          >
            {t("git.fetch")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy || !status?.dirty}
            onClick={() => {
              setOpsAnchor(null);
              void runStash("push");
            }}
          >
            {t("git.stash")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy || !(status?.stashCount ?? 0)}
            onClick={() => {
              setOpsAnchor(null);
              void runStash("pop");
            }}
          >
            {t("git.pop")}
          </button>
        </div>
      ) : null}
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
          {fullscreen ? null : sheetNavigator ? (
            <>
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
