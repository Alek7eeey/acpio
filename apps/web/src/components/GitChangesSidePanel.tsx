import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { GitChangedFileDto, GitCommitDetailDto, GitCommitDto, GitStatusDto } from "@acpio/shared";
import { DiffTextView, type DiffContextSource } from "./DiffTextView";
import { GitChangesCommitPane } from "./GitChangesCommitPane";
import { GitCommitHistory } from "./GitCommitHistory";
import { GitCommitDetail } from "./GitCommitDetail";
import { GitBranchSwitcher } from "./ComposerGitBar";
import { useT } from "../lib/i18n";
import { api } from "../lib/api";
import { showToast } from "../lib/toast";
import { useAppStore } from "../lib/store";
import { isSidePanelResizeAllowed, useNarrowPanelLayout } from "../lib/panelLayout";
import { firstChangedFilePath, firstCommitFilePath } from "../lib/gitFileTree";
import { formatGitErrorToast, gitConflictFiles, gitPullConflictMessage, gitSyncSuccessMessage, isGitConflictFile } from "../lib/gitUi";
import styles from "./GitChangesSidePanel.module.css";

const WIDTH_KEY = "acpio.gitPanelWidth.v1";
const WIDTH_MIN = 320;
const WIDTH_MAX = 920;
const WIDTH_DEFAULT = 520;
const HISTORY_LIST_WIDTH_KEY = "acpio.gitHistoryListWidth.v1";
const HISTORY_LIST_WIDTH_MIN = 140;
const HISTORY_LIST_WIDTH_MAX = 520;
const HISTORY_LIST_WIDTH_DEFAULT = 220;
const HISTORY_DETAIL_HEIGHT_KEY = "acpio.gitHistoryDetailHeight.v1";
const HISTORY_DETAIL_HEIGHT_MIN = 120;
const HISTORY_DETAIL_HEIGHT_MAX = 560;
const HISTORY_DETAIL_HEIGHT_DEFAULT = 240;
const CHANGES_TREE_WIDTH_KEY = "acpio.gitChangesTreeWidth.v1";
const CHANGES_TREE_WIDTH_MIN = 200;
const CHANGES_TREE_WIDTH_MAX = 560;
const CHANGES_TREE_WIDTH_DEFAULT = 320;
/** History list stacks above detail below this width (matches @container git-panel). */
const GIT_HISTORY_STACKED_MAX = 768;
type PanelTab = "changes" | "history";
type Selection =
  | { kind: "working"; path: string | null }
  | { kind: "commit"; hash: string; filePath: string | null };

function readStoredWidth() {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    /* ignore */
  }
  return WIDTH_DEFAULT;
}

function readHistoryListWidth() {
  try {
    const raw = localStorage.getItem(HISTORY_LIST_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(HISTORY_LIST_WIDTH_MAX, Math.max(HISTORY_LIST_WIDTH_MIN, n));
  } catch {
    /* ignore */
  }
  return HISTORY_LIST_WIDTH_DEFAULT;
}

function readHistoryDetailHeight() {
  try {
    const raw = localStorage.getItem(HISTORY_DETAIL_HEIGHT_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(HISTORY_DETAIL_HEIGHT_MAX, Math.max(HISTORY_DETAIL_HEIGHT_MIN, n));
  } catch {
    /* ignore */
  }
  return HISTORY_DETAIL_HEIGHT_DEFAULT;
}

function readChangesTreeWidth() {
  try {
    const raw = localStorage.getItem(CHANGES_TREE_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) return Math.min(CHANGES_TREE_WIDTH_MAX, Math.max(CHANGES_TREE_WIDTH_MIN, n));
  } catch {
    /* ignore */
  }
  return CHANGES_TREE_WIDTH_DEFAULT;
}

function GitActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={styles.actionBtn} disabled={disabled} onClick={onClick} title={label}>
      <span className={styles.actionLabel}>{label}</span>
      <span className={styles.actionIcon}>{children}</span>
    </button>
  );
}

export function GitChangesSidePanel({
  sessionId,
  open,
  status,
  statusLoading = false,
  awaitingGit = false,
  branchBusy,
  onClose,
  onStatusChange,
  onCheckout,
}: {
  sessionId: string;
  open: boolean;
  status: GitStatusDto | null;
  statusLoading?: boolean;
  awaitingGit?: boolean;
  branchBusy: boolean;
  onClose: () => void;
  onStatusChange: (status: GitStatusDto) => void;
  onCheckout: (branch: string, create?: boolean) => Promise<void>;
}) {
  const t = useT();
  const presentation = useAppStore((s) => s.gitPanelPresentation);
  const togglePresentation = useAppStore((s) => s.toggleGitPanelPresentation);
  const narrowPanel = useNarrowPanelLayout();
  const [width, setWidth] = useState(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const historyListDragRef = useRef<
    | { axis: "x"; startX: number; startWidth: number }
    | { axis: "y"; startY: number; startHeight: number }
    | null
  >(null);
  const historyDetailDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const changesTreeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const syncInFlightRef = useRef(false);
  const [tab, setTab] = useState<PanelTab>("changes");
  const [selection, setSelection] = useState<Selection>({ kind: "working", path: null });
  const [diff, setDiff] = useState("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitSummary, setCommitSummary] = useState("");
  const [commitDescription, setCommitDescription] = useState("");
  const [commits, setCommits] = useState<GitCommitDto[]>([]);
  const [outgoing, setOutgoing] = useState<GitCommitDto[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetailDto | null>(null);
  const [loadingCommitDetail, setLoadingCommitDetail] = useState(false);
  const [historyListWidth, setHistoryListWidth] = useState(readHistoryListWidth);
  const [historyListDragging, setHistoryListDragging] = useState(false);
  const [historyDetailHeight, setHistoryDetailHeight] = useState(readHistoryDetailHeight);
  const [historyDetailDragging, setHistoryDetailDragging] = useState(false);
  const [changesTreeWidth, setChangesTreeWidth] = useState(readChangesTreeWidth);
  const [changesTreeDragging, setChangesTreeDragging] = useState(false);
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const historyLayoutRef = useRef<HTMLDivElement>(null);
  const [historyStacked, setHistoryStacked] = useState(false);
  const loadedDiffKeyRef = useRef<string | null>(null);
  const inflightDiffKeyRef = useRef<string | null>(null);
  const diffCacheRef = useRef(new Map<string, string>());
  const diffRequestRef = useRef(0);
  const diffDismissedRef = useRef(false);
  const diffAutoSelectScopeRef = useRef("");

  const clearLoadedDiff = useCallback(() => {
    loadedDiffKeyRef.current = null;
    inflightDiffKeyRef.current = null;
    // Drop in-flight gitDiff/gitShow so a late response cannot restore a stale pane.
    diffRequestRef.current += 1;
    setLoadingDiff(false);
  }, []);

  const invalidateWorkingDiffCache = useCallback(
    (paths?: string[]) => {
      if (!paths?.length) {
        for (const key of diffCacheRef.current.keys()) {
          if (key.startsWith(`${sessionId}:working:`)) diffCacheRef.current.delete(key);
        }
        return;
      }
      for (const path of paths) {
        diffCacheRef.current.delete(`${sessionId}:working:${path}`);
      }
    },
    [sessionId],
  );

  const resetWorkingDiffView = useCallback(() => {
    invalidateWorkingDiffCache();
    clearLoadedDiff();
    setDiff("");
    setSelection({ kind: "working", path: null });
  }, [clearLoadedDiff, invalidateWorkingDiffCache]);

  const gitErrorToast = useCallback(
    (e: unknown, fallback: string, context?: "checkout" | "sync") => {
      const raw = e instanceof Error ? e.message : fallback;
      showToast(formatGitErrorToast(raw, t, { context }), { tone: "danger" });
    },
    [t],
  );

  const buildWorkingDiffKey = (path: string | null) => `working:${path ?? ""}`;
  const buildCommitDiffKey = (hash: string, filePath: string) => `commit:${hash}:${filePath}`;
  const buildBlameKey = (path: string) => `blame:${path}`;

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_LIST_WIDTH_KEY, String(historyListWidth));
    } catch {
      /* ignore */
    }
  }, [historyListWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_DETAIL_HEIGHT_KEY, String(historyDetailHeight));
    } catch {
      /* ignore */
    }
  }, [historyDetailHeight]);

  useEffect(() => {
    try {
      localStorage.setItem(CHANGES_TREE_WIDTH_KEY, String(changesTreeWidth));
    } catch {
      /* ignore */
    }
  }, [changesTreeWidth]);

  useEffect(() => {
    if (presentation !== "side") return;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [presentation, width]);

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

  const loadWorkingDiff = useCallback(
    async (path: string | null, force = false) => {
      const key = buildWorkingDiffKey(path);
      const cacheKey = `${sessionId}:${key}`;

      if (!force) {
        const cached = diffCacheRef.current.get(cacheKey);
        if (cached !== undefined) {
          loadedDiffKeyRef.current = key;
          setSelection({ kind: "working", path });
          setDiff(cached);
          setLoadingDiff(false);
          return;
        }
        if (loadedDiffKeyRef.current === key || inflightDiffKeyRef.current === key) return;
      }

      const requestId = ++diffRequestRef.current;
      inflightDiffKeyRef.current = key;
      setSelection({ kind: "working", path });
      if (loadedDiffKeyRef.current !== key) setDiff("");
      setLoadingDiff(true);
      try {
        const { diff: text } = await api.gitDiff(sessionId, path ?? undefined);
        if (requestId !== diffRequestRef.current) return;
        diffCacheRef.current.set(cacheKey, text);
        loadedDiffKeyRef.current = key;
        setDiff(text);
      } catch (e) {
        if (requestId !== diffRequestRef.current) return;
        if (loadedDiffKeyRef.current === key) loadedDiffKeyRef.current = null;
        setDiff("");
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        if (requestId !== diffRequestRef.current) return;
        if (inflightDiffKeyRef.current === key) inflightDiffKeyRef.current = null;
        setLoadingDiff(false);
      }
    },
    [sessionId],
  );

  const selectCommit = useCallback(
    async (hash: string, opts?: { keepChangesTab?: boolean }) => {
      clearLoadedDiff();
      setSelection({ kind: "commit", hash, filePath: null });
      setDiff("");
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
    [clearLoadedDiff, sessionId],
  );

  const loadCommitFileDiff = useCallback(
    async (hash: string, filePath: string, force = false) => {
      const key = buildCommitDiffKey(hash, filePath);
      const cacheKey = `${sessionId}:${key}`;

      if (!force) {
        const cached = diffCacheRef.current.get(cacheKey);
        if (cached !== undefined) {
          loadedDiffKeyRef.current = key;
          setSelection({ kind: "commit", hash, filePath });
          setDiff(cached);
          setLoadingDiff(false);
          return;
        }
        if (loadedDiffKeyRef.current === key || inflightDiffKeyRef.current === key) return;
      }

      const requestId = ++diffRequestRef.current;
      inflightDiffKeyRef.current = key;
      setSelection({ kind: "commit", hash, filePath });
      if (loadedDiffKeyRef.current !== key) setDiff("");
      setLoadingDiff(true);
      try {
        const { diff: text } = await api.gitShow(sessionId, hash, filePath);
        if (requestId !== diffRequestRef.current) return;
        diffCacheRef.current.set(cacheKey, text);
        loadedDiffKeyRef.current = key;
        setDiff(text);
      } catch (e) {
        if (requestId !== diffRequestRef.current) return;
        if (loadedDiffKeyRef.current === key) loadedDiffKeyRef.current = null;
        setDiff("");
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        if (requestId !== diffRequestRef.current) return;
        if (inflightDiffKeyRef.current === key) inflightDiffKeyRef.current = null;
        setLoadingDiff(false);
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
    if (selection.filePath) {
      await loadCommitFileDiff(selection.hash, selection.filePath, true);
    }
  }, [loadCommitFileDiff, selection, sessionId]);

  const handleCheckout = useCallback(
    async (branch: string, create?: boolean) => {
      await onCheckout(branch, create);
      clearLoadedDiff();
      setSelection({ kind: "working", path: null });
      setDiff("");
      setCommitDetail(null);
      await refreshCommits();
    },
    [clearLoadedDiff, onCheckout, refreshCommits],
  );

  useEffect(() => {
    clearLoadedDiff();
    diffCacheRef.current.clear();
    diffRequestRef.current += 1;
    setDiff("");
    setLoadingDiff(false);
    setCommits([]);
    setCommitDetail(null);
    setSelection({ kind: "working", path: null });
    setTab("changes");
    setCommitSummary("");
    setCommitDescription("");
    setLoadingCommits(false);
    setLoadingCommitDetail(false);
  }, [clearLoadedDiff, sessionId]);

  useEffect(() => {
    if (!open) return;
    clearLoadedDiff();
    diffCacheRef.current.clear();
    diffRequestRef.current += 1;
    setDiff("");
    setLoadingDiff(false);
    diffDismissedRef.current = false;
    setSelection({ kind: "working", path: null });
    void refreshStatus().then(() => {
      void refreshCommits();
    });
  }, [clearLoadedDiff, open, sessionId, refreshStatus, refreshCommits]);

  const clearWorkingFileSelection = useCallback(() => {
    diffDismissedRef.current = true;
    diffRequestRef.current += 1;
    clearLoadedDiff();
    setDiff("");
    setLoadingDiff(false);
    setSelection({ kind: "working", path: null });
  }, [clearLoadedDiff]);

  const clearCommitFileSelection = useCallback(
    (hash: string) => {
      diffDismissedRef.current = true;
      diffRequestRef.current += 1;
      clearLoadedDiff();
      setDiff("");
      setLoadingDiff(false);
      setSelection({ kind: "commit", hash, filePath: null });
    },
    [clearLoadedDiff],
  );

  const toggleWorkingFile = useCallback(
    (path: string) => {
      if (selection.kind === "working" && selection.path === path) {
        clearWorkingFileSelection();
        return;
      }
      diffDismissedRef.current = false;
      void loadWorkingDiff(path);
    },
    [clearWorkingFileSelection, loadWorkingDiff, selection],
  );

  const toggleCommitFile = useCallback(
    (hash: string, filePath: string) => {
      if (selection.kind === "commit" && selection.hash === hash && selection.filePath === filePath) {
        clearCommitFileSelection(hash);
        return;
      }
      diffDismissedRef.current = false;
      void loadCommitFileDiff(hash, filePath);
    },
    [clearCommitFileSelection, loadCommitFileDiff, selection],
  );

  const setFilesStage = useCallback(
    async (paths: string[], staged: boolean) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitStage(sessionId, paths, staged);
        onStatusChange(result.status);
        invalidateWorkingDiffCache(paths);
        if (selection.kind === "working") void loadWorkingDiff(selection.path, true);
      } catch (e) {
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(false);
      }
    },
    [invalidateWorkingDiffCache, loadWorkingDiff, onStatusChange, selection, sessionId],
  );

  const refreshAfterFileMutation = useCallback(
    async (nextStatus: GitStatusDto, affectedPaths: string[]) => {
      onStatusChange(nextStatus);
      invalidateWorkingDiffCache(affectedPaths);
      if (selection.kind !== "working") return;
      const stillExists = affectedPaths.some((path) => nextStatus.files.some((f) => f.path === path));
      if (stillExists && selection.path && nextStatus.files.some((f) => f.path === selection.path)) {
        void loadWorkingDiff(selection.path, true);
      } else if (nextStatus.dirty) {
        clearLoadedDiff();
        setDiff("");
        setSelection({ kind: "working", path: null });
      } else {
        clearLoadedDiff();
        setDiff("");
        setSelection({ kind: "working", path: null });
      }
    },
    [clearLoadedDiff, invalidateWorkingDiffCache, loadWorkingDiff, onStatusChange, selection],
  );

  const discardPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      try {
        const result = await api.gitDiscard(sessionId, paths);
        await refreshAfterFileMutation(result.status, paths);
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
        await refreshAfterFileMutation(result.status, paths);
        showToast(t("git.deleteOk"), { tone: "success" });
      } catch (e) {
        gitErrorToast(e, t("git.syncFailed"));
      } finally {
        setBusy(false);
      }
    },
    [refreshAfterFileMutation, sessionId, t],
  );

  const loadWorkingBlame = useCallback(
    async (path: string) => {
      const key = buildBlameKey(path);
      if (loadedDiffKeyRef.current === key || inflightDiffKeyRef.current === key) return;

      inflightDiffKeyRef.current = key;
      const showLoading = loadedDiffKeyRef.current !== key;
      if (showLoading) setLoadingDiff(true);
      try {
        const { blame } = await api.gitBlame(sessionId, path);
        loadedDiffKeyRef.current = key;
        setDiff(blame);
        setSelection({ kind: "working", path });
      } catch (e) {
        if (loadedDiffKeyRef.current === key) loadedDiffKeyRef.current = null;
        setDiff("");
        showToast(String(e instanceof Error ? e.message : e));
      } finally {
        if (inflightDiffKeyRef.current === key) inflightDiffKeyRef.current = null;
        setLoadingDiff(false);
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

  const focusConflictFiles = useCallback(
    (nextStatus: GitStatusDto) => {
      const conflicts = gitConflictFiles(nextStatus);
      if (conflicts.length === 0) return;
      setTab("changes");
      const first = conflicts[0]!.path;
      setSelection({ kind: "working", path: first });
      void loadWorkingDiff(first, true);
    },
    [loadWorkingDiff],
  );

  const refreshAfterSync = useCallback(
    async (result: { status: GitStatusDto }) => {
      try {
        if (selection.kind === "working" && result.status.dirty && selection.path) {
          invalidateWorkingDiffCache();
          void loadWorkingDiff(selection.path, true);
        } else if (selection.kind === "working") {
          resetWorkingDiffView();
        } else if (selection.kind === "commit") {
          void reloadHistorySelection();
        }
        await refreshCommits();
      } catch {
        /* sync already succeeded — don't surface secondary refresh errors as a failed push */
      }
    },
    [
      invalidateWorkingDiffCache,
      loadWorkingDiff,
      refreshCommits,
      reloadHistorySelection,
      resetWorkingDiffView,
      selection,
    ],
  );

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
        await refreshAfterSync(result);
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
      if (selection.kind === "working" && result.status.dirty && selection.path) {
        invalidateWorkingDiffCache();
        void loadWorkingDiff(selection.path, true);
      } else if (selection.kind === "working") {
        resetWorkingDiffView();
      } else if (selection.kind === "commit") {
        void reloadHistorySelection();
      }
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
        clearLoadedDiff();
        setDiff("");
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
      clearLoadedDiff();
      setTab("history");
      setSelection({ kind: "commit", hash, filePath: null });
      setCommitDetail(null);
      setDiff("");
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
    resetWorkingDiffView();
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
        await refreshAfterSync(syncResult);
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

  const onSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (presentation !== "side" || !isSidePanelResizeAllowed()) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [presentation, width],
  );

  const onSplitterDoubleClick = useCallback(() => {
    if (presentation !== "side" || !isSidePanelResizeAllowed()) return;
    setWidth(WIDTH_DEFAULT);
  }, [presentation]);

  const onHistorySplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (historyStacked) {
        historyListDragRef.current = { axis: "y", startY: e.clientY, startHeight: historyListWidth };
      } else {
        historyListDragRef.current = { axis: "x", startX: e.clientX, startWidth: historyListWidth };
      }
      setHistoryListDragging(true);
    },
    [historyListWidth, historyStacked],
  );

  const onHistorySplitterDoubleClick = useCallback(() => {
    setHistoryListWidth(HISTORY_LIST_WIDTH_DEFAULT);
  }, []);

  const onHistoryDiffSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      historyDetailDragRef.current = { startY: e.clientY, startHeight: historyDetailHeight };
      setHistoryDetailDragging(true);
    },
    [historyDetailHeight],
  );

  const onHistoryDiffSplitterDoubleClick = useCallback(() => {
    setHistoryDetailHeight(HISTORY_DETAIL_HEIGHT_DEFAULT);
  }, []);

  const onChangesSplitterDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (window.innerWidth <= 700) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      changesTreeDragRef.current = { startX: e.clientX, startWidth: changesTreeWidth };
      setChangesTreeDragging(true);
    },
    [changesTreeWidth],
  );

  const onChangesSplitterDoubleClick = useCallback(() => {
    setChangesTreeWidth(CHANGES_TREE_WIDTH_DEFAULT);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const max = Math.min(WIDTH_MAX, Math.floor(window.innerWidth * 0.62));
      const next = drag.startWidth - (e.clientX - drag.startX);
      setWidth(Math.min(max, Math.max(WIDTH_MIN, next)));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!historyListDragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = historyListDragRef.current;
      if (!drag) return;
      const next =
        drag.axis === "y"
          ? drag.startHeight + (e.clientY - drag.startY)
          : drag.startWidth + (e.clientX - drag.startX);
      setHistoryListWidth(Math.min(HISTORY_LIST_WIDTH_MAX, Math.max(HISTORY_LIST_WIDTH_MIN, next)));
    };
    const onUp = () => {
      historyListDragRef.current = null;
      setHistoryListDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [historyListDragging]);

  useEffect(() => {
    if (!historyDetailDragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = historyDetailDragRef.current;
      if (!drag) return;
      const next = drag.startHeight + (e.clientY - drag.startY);
      setHistoryDetailHeight(Math.min(HISTORY_DETAIL_HEIGHT_MAX, Math.max(HISTORY_DETAIL_HEIGHT_MIN, next)));
    };
    const onUp = () => {
      historyDetailDragRef.current = null;
      setHistoryDetailDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [historyDetailDragging]);

  useEffect(() => {
    if (!changesTreeDragging) return;
    const onMove = (e: PointerEvent) => {
      const drag = changesTreeDragRef.current;
      if (!drag) return;
      const next = drag.startWidth + (e.clientX - drag.startX);
      setChangesTreeWidth(Math.min(CHANGES_TREE_WIDTH_MAX, Math.max(CHANGES_TREE_WIDTH_MIN, next)));
    };
    const onUp = () => {
      changesTreeDragRef.current = null;
      setChangesTreeDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [changesTreeDragging]);

  useEffect(() => {
    if (!dragging && !historyListDragging && !historyDetailDragging && !changesTreeDragging) return;
    const prev = document.body.style.cursor;
    if (dragging || changesTreeDragging) document.body.style.cursor = "col-resize";
    else if (historyListDragging) document.body.style.cursor = historyStacked ? "row-resize" : "col-resize";
    else if (historyDetailDragging) document.body.style.cursor = "row-resize";
    document.body.classList.add(styles.resizingBody);
    return () => {
      document.body.style.cursor = prev;
      document.body.classList.remove(styles.resizingBody);
    };
  }, [dragging, historyListDragging, historyDetailDragging, changesTreeDragging, historyStacked]);

  useEffect(() => {
    if (!open) {
      setHistoryStacked(false);
      return;
    }
    const measureEl =
      tab === "history" ? historyLayoutRef.current ?? panelBodyRef.current : panelBodyRef.current;
    if (!measureEl) return;

    const sync = () => {
      const el =
        tab === "history" ? historyLayoutRef.current ?? panelBodyRef.current : panelBodyRef.current;
      if (!el) return;
      setHistoryStacked(narrowPanel || el.clientWidth <= GIT_HISTORY_STACKED_MAX);
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(measureEl);
    if (panelBodyRef.current && panelBodyRef.current !== measureEl) {
      ro.observe(panelBodyRef.current);
    }
    return () => ro.disconnect();
  }, [narrowPanel, open, tab]);

  const diffAutoSelectScope =
    selection.kind === "commit" ? `commit:${selection.hash}` : "working";

  useEffect(() => {
    if (diffAutoSelectScopeRef.current !== diffAutoSelectScope) {
      diffAutoSelectScopeRef.current = diffAutoSelectScope;
      diffDismissedRef.current = false;
    }
  }, [diffAutoSelectScope]);

  useEffect(() => {
    diffDismissedRef.current = false;
    diffAutoSelectScopeRef.current = "";
  }, [sessionId]);

  useEffect(() => {
    if (!open || !status?.dirty || selection.kind !== "working") return;
    if (diffDismissedRef.current && !selection.path) return;
    const filePaths = status.files.map((f) => f.path);
    if (selection.path && filePaths.includes(selection.path)) return;
    const first = firstChangedFilePath({
      conflictFiles: status.files.filter(isGitConflictFile),
      unstagedFiles: status.files.filter((f) => f.unstaged && !isGitConflictFile(f)),
      stagedFiles: status.files.filter((f) => f.staged && !isGitConflictFile(f)),
      files: status.files,
    });
    if (first) void loadWorkingDiff(first);
  }, [loadWorkingDiff, open, selection, status]);

  useEffect(() => {
    if (!open || selection.kind !== "commit" || !commitDetail?.files.length) return;
    if (diffDismissedRef.current && !selection.filePath) return;
    if (selection.filePath && commitDetail.files.some((f) => f.path === selection.filePath)) return;
    const first = firstCommitFilePath(commitDetail.files);
    if (first) void loadCommitFileDiff(selection.hash, first);
  }, [commitDetail, loadCommitFileDiff, open, selection]);

  const selectWorkingFile = useCallback(
    (path: string) => {
      toggleWorkingFile(path);
    },
    [toggleWorkingFile],
  );

  const diffContextSource = useMemo((): DiffContextSource | undefined => {
    if (!status?.repo) return undefined;
    if (selection.kind === "commit") {
      return { sessionId, mode: "commit", commitRev: selection.hash };
    }
    return { sessionId, mode: "working" };
  }, [selection, sessionId, status?.repo]);

  if (!open) return null;

  const repoPending = statusLoading || (awaitingGit && !status);
  const files = status?.files ?? [];
  const repo = status?.repo ?? false;
  const conflictFiles = files.filter(isGitConflictFile);
  const stagedFiles = files.filter((f) => f.staged && !isGitConflictFile(f));
  const unstagedFiles = files.filter((f) => f.unstaged && !isGitConflictFile(f));
  const workingSelected = selection.kind === "working";
  const commitSelected = selection.kind === "commit";
  const historyFileSelected =
    (commitSelected && Boolean(selection.filePath)) ||
    (workingSelected && Boolean(selection.path));

  const commitPaneProps = {
    files,
    conflictFiles,
    stagedFiles,
    unstagedFiles,
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
    onSelectFile: selectWorkingFile,
    onCommit: (e: FormEvent) => void onCommit(e),
    onCommitAndPush: () => void onCommitAndPush(),
    onStageAndCommit: () => void stageAll(),
    repoRoot: status?.root,
    onDiscardPaths: discardPaths,
    onDeletePaths: deletePaths,
    onBlameFile: loadWorkingBlame,
    layout: "workspace" as const,
    outgoing,
    outgoingLoading: loadingCommitDetail,
    commitHash: commitSelected ? selection.hash : null,
    commitFilePath: commitSelected ? selection.filePath : null,
    outgoingFiles:
      commitSelected && commitDetail?.hash === selection.hash ? commitDetail.files : [],
    onInspectOutgoing: (hash: string) => void selectCommit(hash, { keepChangesTab: true }),
    onSelectOutgoingFile: (hash: string, path: string) => void loadCommitFileDiff(hash, path),
  };

  const panelInner = (
    <>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <span className={styles.headerBranchIcon} aria-hidden>
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
          <div className={styles.headerLead}>
            <span className={styles.headerKicker}>{t("git.title")}</span>
            {repoPending ? (
              <span className={styles.headerLoading}>
                <span className={styles.loaderSpin} aria-hidden />
                {t("git.initializing")}
              </span>
            ) : status?.repo ? (
              <GitBranchSwitcher
                status={status}
                branchBusy={branchBusy}
                onCheckout={handleCheckout}
                variant="panelHeader"
              />
            ) : (
              <h2 className={styles.headerTitle}>{t("git.title")}</h2>
            )}
          </div>
          <div className={styles.headerIconRow}>
            <button
              type="button"
              className={styles.iconBtn}
              disabled={busy}
              onClick={() => {
                void refreshStatus();
                void refreshCommits().then(() => {
                  if (selection.kind === "working" && status?.dirty) void loadWorkingDiff(selection.path, true);
                  else if (selection.kind === "commit") void reloadHistorySelection();
                });
              }}
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={t("common.cancel")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {!narrowPanel ? (
          <div className={styles.headerPresentationRow}>
            <button
              type="button"
              className={`${styles.presentationBtn}${
                presentation === "modal" ? ` ${styles.presentationBtnActive}` : ""
              }`}
              onClick={() => togglePresentation()}
              title={presentation === "modal" ? t("git.dockToSide") : t("git.openInModal")}
              aria-pressed={presentation === "modal"}
            >
              {presentation === "modal" ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="4" y="5" width="10" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
                  <path
                    d="M16 8h4v11a2 2 0 0 1-2 2h-2"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
                  <path d="M8 3h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  <path
                    d="M9 9h6M9 12h6M9 15h4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              <span>{presentation === "modal" ? t("git.dockToSide") : t("git.openInModal")}</span>
            </button>
          </div>
        ) : null}

        {status && !repoPending ? (
          <div className={styles.headerMetaRow}>
            <div className={styles.headerStatsGroup}>
              {status.dirty ? (
                <>
                  <span className={styles.statAdd}>+{status.additions}</span>
                  <span className={styles.statDel}>-{status.deletions}</span>
                </>
              ) : (
                <span className={styles.headerClean}>{t("git.noChanges")}</span>
              )}
            </div>
            <div className={styles.countPills}>
              {status.conflict ? (
                <span className={`${styles.countPill} ${styles.countPillConflict}`}>
                  {t("git.conflictCount", { count: conflictFiles.length })}
                </span>
              ) : null}
              <span
                className={`${styles.countPill}${status.stagedCount > 0 ? ` ${styles.countPillStaged}` : ""}`}
              >
                {t("git.stagedCount", { count: status.stagedCount })}
              </span>
              <span
                className={`${styles.countPill}${status.unstagedCount > 0 ? ` ${styles.countPillUnstaged}` : ""}`}
              >
                {t("git.unstagedCount", { count: status.unstagedCount })}
              </span>
            </div>
          </div>
        ) : null}

        {repo && !repoPending ? (
          <div className={styles.viewToggleRow}>
            <div className={styles.viewTabs} role="tablist" aria-label={t("git.title")}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "changes"}
                className={`${styles.viewTab}${tab === "changes" ? ` ${styles.viewTabActive}` : ""}`}
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
                className={`${styles.viewTab}${tab === "history" ? ` ${styles.viewTabActive}` : ""}`}
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
        ) : null}

        <div className={styles.headerToolbar}>
          <div className={styles.actionBar} role="toolbar" aria-label={t("git.title")}>
            <GitActionButton label={t("git.fetch")} disabled={busy} onClick={() => void runSync("fetch")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M20 7v4h-4M4 17v-4h4M20 7a8 8 0 0 0-13.5-3M4 17a8 8 0 0 0 13.5 3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </GitActionButton>
            <GitActionButton label={t("git.pull")} disabled={busy} onClick={() => void runSync("pull")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 5v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path
                  d="M8 11l4 4 4-4M6 19h12"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </GitActionButton>
            <GitActionButton label={t("git.push")} disabled={busy} onClick={() => void runSync("push")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M12 19V9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path
                  d="M8 13l4-4 4 4M6 5h12"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </GitActionButton>
            <span className={styles.actionDivider} aria-hidden />
            <GitActionButton
              label={t("git.stash")}
              disabled={busy || !status?.dirty}
              onClick={() => void runStash("push")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M7 16h10v4H7v-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M6 20h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M12 4v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path
                  d="M9 10l3 3 3-3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </GitActionButton>
            <GitActionButton
              label={t("git.pop")}
              disabled={busy || !(status?.stashCount ?? 0)}
              onClick={() => void runStash("pop")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M7 16h10v4H7v-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M6 20h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M12 20V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path
                  d="M9 14l3-3 3 3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </GitActionButton>
          </div>
        </div>
      </div>

      {repoPending ? (
        <div className={`${styles.empty} ${styles.emptyLoading}`}>
          <span className={styles.loaderSpin} aria-hidden />
          {t("git.initializing")}
        </div>
      ) : !repo ? (
        <div className={styles.empty}>{t("git.noRepo")}</div>
      ) : (
        <div className={styles.panelBody} ref={panelBodyRef}>
          <div className={`${styles.body}${tab === "history" ? ` ${styles.bodyHistory}` : ` ${styles.bodyChanges}`}`}>
            {tab === "changes" ? (
              <div
                className={`${styles.changesLayout}${
                  changesTreeDragging ? ` ${styles.changesResizing}` : ""
                }`}
                style={{ ["--changes-tree-width" as string]: `${changesTreeWidth}px` } as CSSProperties}
              >
                <GitChangesCommitPane {...commitPaneProps} />
                <div
                  className={styles.changesSplitter}
                  onPointerDown={onChangesSplitterDown}
                  onDoubleClick={onChangesSplitterDoubleClick}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("common.resizePlan")}
                  title={t("common.resizePlanHint")}
                />
                <div className={styles.diffPane}>
                  {loadingDiff ? (
                    <div className={styles.empty}>{t("common.loading")}</div>
                  ) : diff.trim() ? (
                    <DiffTextView text={diff} contextSource={diffContextSource} />
                  ) : (
                    <div className={styles.empty}>
                      {commitSelected || status?.dirty ? t("git.pickFileDiff") : t("git.noChanges")}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div
                ref={historyLayoutRef}
                className={`${styles.historyLayout}${
                  historyStacked ? ` ${styles.historyLayoutStacked}` : ""
                }${
                  historyListDragging || historyDetailDragging ? ` ${styles.historyResizing}` : ""
                }${historyFileSelected ? ` ${styles.historyLayoutWithDiff}` : ""}`}
                style={
                  {
                    ["--history-list-width" as string]: `${historyListWidth}px`,
                    ["--history-list-height" as string]: `${historyListWidth}px`,
                  } as CSSProperties
                }
              >
                <div className={styles.historyListPane}>
                  <GitCommitHistory
                    commits={commits}
                    status={status}
                    loading={loadingCommits}
                    busy={busy}
                    selectedHash={commitSelected ? selection.hash : null}
                    wipSelected={workingSelected && Boolean(status?.dirty)}
                    onSelectCommit={(hash) => void selectCommit(hash)}
                    onSelectWip={() => {
                      clearLoadedDiff();
                      diffDismissedRef.current = false;
                      setTab("history");
                      setSelection({ kind: "working", path: null });
                      setCommitDetail(null);
                      setDiff("");
                    }}
                    onRevertCommit={(hash) => void runCommitAction("revert", hash)}
                    onCherryPickCommit={(hash) => void runCommitAction("cherry-pick", hash)}
                    onCreateBranchAt={(hash, branch) => void createBranchAt(hash, branch)}
                    onCreateTagAt={(hash, tag) => void createTagAt(hash, tag)}
                    onCheckoutCommit={(hash) => void checkoutCommit(hash)}
                  />
                </div>
                <div
                  className={styles.historySplitter}
                  onPointerDown={onHistorySplitterDown}
                  onDoubleClick={onHistorySplitterDoubleClick}
                  role="separator"
                  aria-orientation={historyStacked ? "horizontal" : "vertical"}
                  aria-label={t("common.resizePlan")}
                  title={t("common.resizePlanHint")}
                />
                <div
                  className={styles.historyRightPane}
                  style={
                    historyFileSelected
                      ? ({ ["--history-detail-height" as string]: `${historyDetailHeight}px` } as CSSProperties)
                      : undefined
                  }
                >
                  <div className={styles.historyDetailPane}>
                    <GitCommitDetail
                      loading={loadingCommitDetail}
                      detail={commitSelected ? commitDetail : null}
                      repoRoot={status?.root}
                      wipFiles={workingSelected && status?.dirty ? status.files : undefined}
                      selectedFilePath={
                        commitSelected ? selection.filePath : workingSelected ? selection.path : null
                      }
                      onSelectFile={(path) => {
                        if (commitSelected) toggleCommitFile(selection.hash, path);
                        else toggleWorkingFile(path);
                      }}
                      onSelectParent={(hash) => void selectCommit(hash)}
                      onBlameFile={loadWorkingBlame}
                      wipMode={workingSelected && Boolean(status?.dirty)}
                    />
                  </div>
                  {historyFileSelected ? (
                    <>
                      <div
                        className={styles.historyDiffSplitter}
                        onPointerDown={onHistoryDiffSplitterDown}
                        onDoubleClick={onHistoryDiffSplitterDoubleClick}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={t("git.resizeHistoryDetail")}
                        title={t("git.resizeHistoryDetail")}
                      />
                      <div className={styles.diffPane}>
                        {loadingDiff ? (
                          <div className={styles.empty}>{t("common.loading")}</div>
                        ) : diff.trim() ? (
                          <DiffTextView text={diff} contextSource={diffContextSource} />
                        ) : (
                          <div className={styles.empty}>{t("git.pickFileDiff")}</div>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </>
  );

  if (presentation === "modal") {
    return createPortal(
      <div
        className={styles.modalOverlay}
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className={styles.modalShell}
          role="dialog"
          aria-modal="true"
          aria-label={t("git.title")}
        >
          <aside className={`${styles.panel} ${styles.panelInModal}`}>{panelInner}</aside>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <aside
      className={`${styles.panel} ${dragging ? styles.resizing : ""}${
        narrowPanel ? ` ${styles.panelMobile}` : ""
      }`}
      aria-label={t("git.title")}
      style={{ ["--git-panel-width"]: `${width}px` } as CSSProperties}
    >
      <div
        className={styles.splitter}
        onPointerDown={onSplitterDown}
        onDoubleClick={onSplitterDoubleClick}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("common.resizePlan")}
        aria-valuenow={width}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        title={t("common.resizePlanHint")}
      />
      {panelInner}
    </aside>
  );
}
