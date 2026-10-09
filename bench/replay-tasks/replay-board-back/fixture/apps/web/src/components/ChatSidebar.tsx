import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import type { AgentProvider, BoardDto, SessionDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { harnessLabel, harnessNamesForCopy } from "../lib/harness";
import { isShellSession } from "@acpio/shared";
import { sessionTreeDisplayTitle, sessionActivityAt, sessionRowMark, sortSessions, groupByFolder } from "../lib/sessionTitle";
import { canonicalCwd } from "@acpio/shared";
import { folderLabel } from "../lib/pathSegments";
import { FALLBACK_CHAT_PANES } from "../lib/chatPanes";
import { isChatSearchEnabled } from "../lib/chatTreeSearch";
import { useAppStore } from "../lib/store";
import {
  listLikedMessages,
  subscribeLikedMessages,
  type LikedMessage,
} from "../lib/likedMessages";
import { showToast } from "../lib/toast";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "./CreateSessionFolderPicker";
import { ExportDialog } from "./ExportDialog";
import { McpFolderDialog } from "./McpFolderDialog";
import styles from "./AppShell.module.css";

/** Tree section key for chats that live outside any folder. */
const NO_FOLDER_KEY = "__no_folder__";

type MenuState = {
  id: string;
  x: number;
  y: number;
  anchorTop: number;
  anchorBottom: number;
  anchorRight?: number;
} | null;

type FolderPickerState = {
  x: number;
  y: number;
  dialogStartPath?: string;
  lockedCwd?: string;
};

/** Kanban board glyph for the chat tree: three task columns. */
function BoardGlyph() {
  return (
    <svg width="14" height="13" viewBox="0 0 24 20" fill="none" aria-hidden>
      <rect x="3" y="3" width="4.4" height="14" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="9.8" y="3" width="4.4" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="16.6" y="3" width="4.4" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Filled manila folder glyph for the chat tree. */
function FolderGlyph() {
  return (
    <svg width="15" height="13" viewBox="0 0 24 20" aria-hidden>
      <path
        className={styles.folderIconTab}
        d="M1.5 4.2A1.7 1.7 0 0 1 3.2 2.5h5.1l1.7 1.8h10.8A1.7 1.7 0 0 1 22.5 6v1.2H1.5V4.2Z"
      />
      <path
        className={styles.folderIconEdge}
        d="M1.5 7.2h21v10.1A1.7 1.7 0 0 1 20.8 19H3.2A1.7 1.7 0 0 1 1.5 17.3V7.2Z"
      />
      <path
        className={styles.folderIconBody}
        d="M1.5 8h21v9.3A1.7 1.7 0 0 1 20.8 19H3.2A1.7 1.7 0 0 1 1.5 17.3V8Z"
      />
      <path className={styles.folderIconFront} d="M1.5 8h21v2.4H1.5Z" opacity="0.55" />
    </svg>
  );
}

function startOfLocalDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function stripDateDots(value: string) {
  return value.replace(/\./g, "").replace(/\s+/g, " ").trim();
}

export function formatRelativeActivity(
  iso: string,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  nowMs: number,
) {
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) return "";
  const then = new Date(thenMs);
  const now = new Date(nowMs);
  const diffMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return t("common.relativeJustNow");
  if (minutes < 60) return t("common.relativeMinutes", { count: minutes });

  const thenDay = startOfLocalDay(then);
  const nowDay = startOfLocalDay(now);
  const dayDiff = Math.round((nowDay - thenDay) / 86_400_000);

  if (dayDiff === 0) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(then);
  }
  if (dayDiff === 1) return t("common.relativeYesterday");
  if (dayDiff > 1 && dayDiff < 7) {
    return stripDateDots(
      new Intl.DateTimeFormat(locale, { weekday: "short" }).format(then),
    );
  }

  const sameYear = then.getFullYear() === now.getFullYear();
  return stripDateDots(
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "2-digit" }),
    }).format(then),
  );
}

/** Coarse bucket for grouping siblings that share the same relative day/period. */
function activityBucket(
  iso: string,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  nowMs: number,
): { key: string; label: string } | null {
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) return null;
  const then = new Date(thenMs);
  const now = new Date(nowMs);
  const thenDay = startOfLocalDay(then);
  const nowDay = startOfLocalDay(now);
  const dayDiff = Math.round((nowDay - thenDay) / 86_400_000);

  if (dayDiff <= 0) {
    return { key: "today", label: t("common.relativeToday") };
  }
  if (dayDiff === 1) {
    return { key: "yesterday", label: t("common.relativeYesterday") };
  }
  if (dayDiff > 1 && dayDiff < 7) {
    const label = stripDateDots(
      new Intl.DateTimeFormat(locale, { weekday: "short" }).format(then),
    );
    return { key: `dow:${dayDiff}`, label };
  }

  const sameYear = then.getFullYear() === now.getFullYear();
  const label = stripDateDots(
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "2-digit" }),
    }).format(then),
  );
  return { key: `date:${thenDay}`, label };
}

type TimeGroup = {
  key: string;
  label: string;
  sessions: SessionDto[];
};

function groupSessionsByActivity(
  sessions: SessionDto[],
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  nowMs: number,
): TimeGroup[] {
  const groups: TimeGroup[] = [];
  for (const session of sessions) {
    const bucket = activityBucket(sessionActivityAt(session), locale, t, nowMs);
    const key = bucket?.key ?? `id:${session.id}`;
    const label = bucket?.label ?? "";
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.sessions.push(session);
    } else {
      groups.push({ key, label, sessions: [session] });
    }
  }
  return groups;
}

function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <span className={styles.contextMenuIcon} aria-hidden>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        {children}
      </svg>
    </span>
  );
}

export function ChatSidebar({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const activeBoardId = location.pathname.startsWith("/board/")
    ? location.pathname.slice("/board/".length)
    : null;
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const unseenFinishedTurns = useAppStore((s) => s.unseenFinishedTurns);
  const chatPaneIds = useAppStore((s) => s.chatPaneIds) ?? FALLBACK_CHAT_PANES;
  const chatSplitOn = useAppStore((s) => s.settings.chatSplit !== false);
  const toolbarMinimal = settings.chatToolbarStyle === "minimal";
  const selectSession = useAppStore((s) => s.selectSession);
  const openSessionInNewPane = useAppStore((s) => s.openSessionInNewPane);
  const createSession = useAppStore((s) => s.createSession);
  const importHarnessSession = useAppStore((s) => s.importHarnessSession);
  const adapters = useAppStore((s) => s.adapters);
  const adaptersLoaded = useAppStore((s) => s.adaptersLoaded);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const setSessionFlags = useAppStore((s) => s.setSessionFlags);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setFocusMessageId = useAppStore((s) => s.setFocusMessageId);
  const reorderFolders = useAppStore((s) => s.reorderFolders);
  const reorderSessions = useAppStore((s) => s.reorderSessions);

  const agentOptions = useMemo(
    () =>
      adapters
        .map((a) => ({ id: a.id, label: a.label }))
        .map((a) => ({ ...a, online: agentAvailability[a.id] === true })),
    [adapters, agentAvailability],
  );

  /**
   * Session rows show a harness badge - except for a harness the user turned
   * off, which must not be named anywhere. Shell sessions always show theirs.
   */
  const showProviderBadge = (provider: string): boolean =>
    isShellSession(provider) || !adaptersLoaded || adapters.some((a) => a.id === provider);

  const [liked, setLiked] = useState<LikedMessage[]>(() => listLikedMessages());
  useEffect(() => subscribeLikedMessages(() => setLiked(listLikedMessages())), []);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportDialogId, setExportDialogId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null);
  /** Row being dragged: folder key or `b:<board id>`. */
  const [draggingRowKey, setDraggingRowKey] = useState<string | null>(null);
  /** Row under the pointer during a folder/board drag: folder key or `b:<id>`. */
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragInsertPosition, setDragInsertPosition] = useState<"above" | "below" | null>(null);
  /** A row drag ends on a pointerup the browser still reports as a click. */
  const suppressRowClickRef = useRef(false);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Touch devices hide the inline pin/archive actions (no hover to reveal
  // them), so the ⋮ menu carries those items there. On desktop the hover
  // reveal is enough — keep the menu lean.
  const TOUCH_MQ = "(hover: none), (pointer: coarse)";
  const [isTouch, setIsTouch] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(TOUCH_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(TOUCH_MQ);
    const onChange = () => setIsTouch(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("acpio.collapsedFolders.v1");
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  /**
   * Folders whose "show more" was clicked. Deliberately in-memory only: the
   * chat-tree limit is a display preference shared across devices, while
   * "I want to see this one folder in full" is a short-lived action that must
   * not survive a reload. `chatTreeRecentLimit === 0` disables truncation
   * entirely, and `collapseExpandedFolder` undoes a single expansion.
   */
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const expandFolder = (key: string) => {
    setExpandedFolders((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const collapseExpandedFolder = (key: string) => {
    setExpandedFolders((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Folders that have (or had) chats, persisted on the server so empty
  // folders survive deleting the last chat and are visible from any device.
  const knownFolders = useAppStore((s) => s.knownFolders);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const archiveSessions = useAppStore((s) => s.archiveSessions);
  const boards = useAppStore((s) => s.boards);
  const createBoard = useAppStore((s) => s.createBoard);
  const renameBoard = useAppStore((s) => s.renameBoard);
  const deleteBoard = useAppStore((s) => s.deleteBoard);
  const reorderBoards = useAppStore((s) => s.reorderBoards);

  const toggleFolder = (key: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem("acpio.collapsedFolders.v1", JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  /** Collapse a section key and persist (newly appearing sections start collapsed). */
  const collapseFolder = (key: string) => {
    setCollapsedFolders((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      try {
        localStorage.setItem("acpio.collapsedFolders.v1", JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };
  const prevArchiveCount = useRef(0);
  const prevLikedCount = useRef(0);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  // Deleting a folder removes it and every chat inside, confirmed through the
  // same inline confirm component chat deletion uses.
  const [confirmDeleteFolderCwd, setConfirmDeleteFolderCwd] = useState<string | null>(null);
  const folderConfirmRef = useRef<HTMLDivElement>(null);
  const [folderMenu, setFolderMenu] = useState<{
    cwd: string;
    x: number;
    y: number;
    anchorTop: number;
    anchorBottom: number;
  } | null>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<{ x: number; y: number } | null>(null);
  /** Folder whose per-folder MCP override dialog is open (null = closed). */
  const [mcpFolderCwd, setMcpFolderCwd] = useState<string | null>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  /** Board row context menu + inline rename/delete confirm. */
  const [boardMenu, setBoardMenu] = useState<{ board: BoardDto; x: number; y: number } | null>(
    null,
  );
  const boardMenuRef = useRef<HTMLDivElement>(null);
  const [renamingBoardId, setRenamingBoardId] = useState<string | null>(null);
  const [boardDraft, setBoardDraft] = useState("");
  const [confirmDeleteBoardId, setConfirmDeleteBoardId] = useState<string | null>(null);
  const boardConfirmRef = useRef<HTMLDivElement>(null);

  // Active (non-archived) chats inside the folder whose menu is open — the
  // "archive all" item is dead when the folder has none left.
  const folderMenuActiveCount = useMemo(
    () =>
      folderMenu?.cwd
        ? sessions.filter((s) => !s.archived && canonicalCwd(s.cwd) === folderMenu.cwd).length
        : 0,
    [folderMenu?.cwd, sessions],
  );

  const openFolderMenuAt = (
    cwd: string,
    x: number,
    y: number,
    anchorTop: number,
    anchorBottom: number,
  ) => {
    setMenu(null);
    setConfirmDeleteId(null);
    setConfirmDeleteFolderCwd(null);
    setFolderMenuPos(null);
    setFolderMenu({ cwd, x, y, anchorTop, anchorBottom });
  };

  const openFolderMenu = (e: ReactMouseEvent, cwd: string) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openFolderMenuAt(cwd, e.clientX, e.clientY, rect.top, rect.bottom);
  };

  const commitDeleteFolder = (cwd: string) => {
    setConfirmDeleteFolderCwd(null);
    void deleteFolder(cwd);
    showToast(t("chat.folderDeleted"), { tone: "info" });
  };

  /** Move every active chat of a folder to the archive in one go. */
  const archiveFolderSessions = (cwd: string) => {
    const ids = sessions
      .filter((s) => !s.archived && canonicalCwd(s.cwd) === cwd)
      .map((s) => s.id);
    setFolderMenu(null);
    if (!ids.length) return;
    void archiveSessions(ids);
    showToast(t("common.toastArchiveAll"), {
      tone: "info",
      id: `archive-folder-${cwd}`,
    });
  };

  const renderFolderDeleteConfirm = (cwd: string) => (
    <div
      key={cwd}
      ref={folderConfirmRef}
      className={styles.sessionConfirm}
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.deleteFolderTitle")}
    >
      <div className={styles.sessionConfirmCopy}>
        <div className={styles.sessionConfirmTitle}>{t("chat.deleteFolderTitle")}</div>
        <p className={styles.sessionConfirmText}>
          {t("chat.deleteFolderBody", { name: folderLabel(cwd, t("common.noFolder")) })}
        </p>
      </div>
      <div className={styles.sessionConfirmActions}>
        <button
          type="button"
          className={styles.sessionConfirmCancel}
          onClick={() => setConfirmDeleteFolderCwd(null)}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={styles.sessionConfirmDelete}
          onClick={() => commitDeleteFolder(cwd)}
        >
          {t("common.delete")}
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );

  const visibleSessions = sessions;

  const archivedSessions = useMemo(
    () =>
      settings.chatTreeShowArchive === false
        ? []
        : sortSessions(visibleSessions.filter((s) => s.archived)),
    [visibleSessions, settings.chatTreeShowArchive],
  );
  const folders = useMemo(() => {
    const grouped = groupByFolder(visibleSessions.filter((s) => !s.archived), knownFolders);
    const groupedKeys = new Set(grouped.map((f) => f.cwd));
    const empties = knownFolders
      .filter((cwd) => !groupedKeys.has(cwd))
      .map((cwd) => ({ cwd, sessions: [] as SessionDto[], latest: "" }));
    const all = [...grouped, ...empties];
    all.sort((a, b) => {
      if (!a.cwd && b.cwd) return 1;
      if (a.cwd && !b.cwd) return -1;
      const indexA = knownFolders.indexOf(a.cwd);
      const indexB = knownFolders.indexOf(b.cwd);
      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" });
    });
    return all;
  }, [visibleSessions, knownFolders]);

  // Newly created sections (archive, liked) appear collapsed by default;
  // the user can expand them afterwards as usual.
  useEffect(() => {
    if (archivedSessions.length > 0 && prevArchiveCount.current === 0) {
      collapseFolder("__archive__");
    }
    prevArchiveCount.current = archivedSessions.length;
  }, [archivedSessions.length]);

  useEffect(() => {
    if (liked.length > 0 && prevLikedCount.current === 0) {
      collapseFolder("__liked__");
    }
    prevLikedCount.current = liked.length;
  }, [liked.length]);

  const closeMobile = () => {
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const openChat = (sessionId: string) => {
    void selectSession(sessionId);
    navigate("/chat");
    closeMobile();
  };

  const goToChat = () => {
    navigate("/chat");
    closeMobile();
  };

  const startNewSession = async (cwd?: string, provider?: AgentProvider) => {
    try {
      await createSession(cwd, provider);
      goToChat();
    } catch (err) {
      const message =
        err instanceof Error && err.message === "noAgentsOnline"
          ? t("common.noAgentsOnline")
          : err instanceof Error
            ? err.message
            : String(err);
      showToast(message, { tone: "danger" });
    }
  };

  const openFolderPicker = (opts: {
    x: number;
    y: number;
    dialogStartPath?: string;
    lockedCwd?: string;
  }) => {
    setMenu(null);
    setConfirmDeleteId(null);
    setFolderPicker({
      x: opts.x,
      y: opts.y,
      dialogStartPath: opts.dialogStartPath,
      lockedCwd: opts.lockedCwd,
    });
  };

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menu && !confirmDeleteId && !folderMenu && !confirmDeleteFolderCwd && !boardMenu && !confirmDeleteBoardId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        confirmRef.current?.contains(target) ||
        folderMenuRef.current?.contains(target) ||
        folderConfirmRef.current?.contains(target) ||
        boardMenuRef.current?.contains(target) ||
        boardConfirmRef.current?.contains(target)
      )
        return;
      setMenu(null);
      setConfirmDeleteId(null);
      setFolderMenu(null);
      setConfirmDeleteFolderCwd(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setConfirmDeleteId(null);
        setFolderMenu(null);
        setConfirmDeleteFolderCwd(null);
        setBoardMenu(null);
        setConfirmDeleteBoardId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, confirmDeleteId, folderMenu, confirmDeleteFolderCwd, boardMenu, confirmDeleteBoardId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!confirmDeleteFolderCwd) return;
    folderConfirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteFolderCwd]);

  useEffect(() => {
    if (!confirmDeleteBoardId) return;
    boardConfirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteBoardId]);

  const startRenameSession = (s: SessionDto) => {
    setMenu(null);
    setConfirmDeleteId(null);
    setRenamingId(s.id);
    setDraft(s.title);
  };

  const commitRenameSession = async () => {
    if (!renamingId) return;
    const id = renamingId;
    const title = draft.trim();
    setRenamingId(null);
    if (title) await renameSession(id, title);
  };

  const openSessionMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderPicker(null);
    setConfirmDeleteId(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x =
      e.type === "contextmenu"
        ? e.clientX
        : Math.max(12, Math.min(rect.right - 8, window.innerWidth - 210));
    const y =
      e.type === "contextmenu"
        ? e.clientY
        : rect.bottom + 6;
    setMenuPos(null);
    setMenu({
      id,
      x,
      y,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      ...(e.type === "contextmenu" ? {} : { anchorRight: rect.right }),
    });
  };

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    const margin = 12;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let x =
      menu.anchorRight != null ? menu.anchorRight - width : menu.x;
    x = Math.min(Math.max(margin, x), window.innerWidth - width - margin);
    let y = menu.y;
    if (y + height > window.innerHeight - margin) {
      y = menu.anchorTop - height - 6;
    }
    y = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
    setMenuPos({ x, y });
  }, [menu, settings.chatTreeMenu, isTouch]);

  useLayoutEffect(() => {
    if (!folderMenu || !folderMenuRef.current) {
      setFolderMenuPos(null);
      return;
    }
    const el = folderMenuRef.current;
    const margin = 12;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let x = Math.min(Math.max(margin, folderMenu.x), window.innerWidth - width - margin);
    let y = folderMenu.y;
    if (y + height > window.innerHeight - margin) {
      y = folderMenu.anchorTop - height - 6;
    }
    y = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
    setFolderMenuPos({ x, y });
  }, [folderMenu]);

  const showFolderHeaders = folders.length > 1 || (folders.length === 1 && !!folders[0]?.cwd);
  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : null;
  const dateLocale = settings.locale === "en" ? "en-US" : "ru-RU";
  const recentLimit = settings.chatTreeRecentLimit ?? 0;

  /**
   * Chats to render for a folder: the newest `chatTreeRecentLimit` unless the
   * user expanded the folder (or the setting is 0 = show everything). The
   * active chat is always kept so the tree never hides the one you are in.
   */
  const visibleFolderSessions = (folder: (typeof folders)[number]): SessionDto[] => {
    if (recentLimit <= 0) return folder.sessions;
    const fkey = folder.cwd || NO_FOLDER_KEY;
    if (expandedFolders.has(fkey)) return folder.sessions;
    const head = folder.sessions.slice(0, recentLimit);
    if (!activeSessionId || head.some((s) => s.id === activeSessionId)) return head;
    const active = folder.sessions.find((s) => s.id === activeSessionId);
    if (!active) return head;
    return folder.sessions.filter((s) => head.includes(s) || s.id === active.id);
  };

  // ── Tree virtualization ────────────────────────────────────────────────────
  // The sidebar can accumulate hundreds of sessions; beyond a threshold the
  // tree is flattened into rows and windowed with @tanstack/react-virtual.
  // Small trees keep the plain render (no measurement/scroll subtleties).
  type TreeRow =
    | { kind: "folder-head"; key: string; folder: (typeof folders)[number] }
    | { kind: "folder-empty"; key: string; cwd: string }
    | { kind: "folder-more"; key: string; cwd: string; fkey: string; hidden: number }
    | { kind: "folder-fewer"; key: string; fkey: string }
    | { kind: "folder-confirm"; key: string; cwd: string }
    | { kind: "board"; key: string; board: BoardDto }
    | { kind: "session"; key: string; session: SessionDto; showActivity: boolean; inArchive: boolean; indent: boolean }
    | { kind: "archive-head"; key: string; count: number }
    | { kind: "liked-head"; key: string; count: number }
    | { kind: "liked"; key: string; item: LikedMessage };

  type TreeSection =
    | { kind: "folder"; key: string; folder: (typeof folders)[number] }
    | { kind: "board"; key: string; board: BoardDto };

  /** A sidebar row addressed by kind + id, used for ordering operations. */
  type TreeToken = { kind: "folder" | "board"; id: string };

  /**
   * Folders and boards share one display sequence, so a board can sit anywhere
   * between folders. A board's `sortOrder` is its slot index in that sequence;
   * folders keep their own relative order and flow into the remaining slots.
   */
  const treeSections = useMemo<TreeSection[]>(() => {
    const realFolders = folders.filter((f) => !!f.cwd);
    const noFolder = folders.find((f) => !f.cwd) ?? null;
    const slots = realFolders.length + boards.length;
    const ordered = [...boards].sort((a, b) => a.sortOrder - b.sortOrder);
    const placed: (BoardDto | null)[] = new Array(slots).fill(null);
    // Slots must stay strictly increasing so a clamped or duplicate sortOrder
    // never collapses two boards onto one row.
    let minNext = 0;
    ordered.forEach((board, idx) => {
      const upper = slots - (ordered.length - idx);
      const slot = Math.min(Math.max(board.sortOrder, minNext), Math.max(minNext, upper));
      placed[slot] = board;
      minNext = slot + 1;
    });
    const out: TreeSection[] = [];
    let fi = 0;
    for (let i = 0; i < slots; i++) {
      const board = placed[i];
      if (board) out.push({ kind: "board", key: `b:${board.id}`, board });
      else if (realFolders[fi])
        out.push({ kind: "folder", key: `f:${realFolders[fi]!.cwd}`, folder: realFolders[fi++]! });
    }
    // Unfiled chats are a bucket, not a movable folder — pin them last.
    if (noFolder) out.push({ kind: "folder", key: `f:${NO_FOLDER_KEY}`, folder: noFolder });
    return out;
  }, [folders, boards]);

  const treeRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    for (const section of treeSections) {
      if (section.kind === "board") {
        rows.push({ kind: "board", key: `b:${section.board.id}`, board: section.board });
        continue;
      }
      const folder = section.folder;
      const fkey = folder.cwd || NO_FOLDER_KEY;
      if (folder.cwd && folder.cwd === confirmDeleteFolderCwd) {
        rows.push({ kind: "folder-confirm", key: `fc:${fkey}`, cwd: folder.cwd });
        continue;
      }
      if (showFolderHeaders) {
        rows.push({ kind: "folder-head", key: `fh:${fkey}`, folder });
      }
      if (collapsedFolders.has(fkey)) continue;
      if (folder.sessions.length === 0) {
        rows.push({ kind: "folder-empty", key: `fe:${fkey}`, cwd: folder.cwd });
        continue;
      }
      const shown = visibleFolderSessions(folder);
      const hidden = folder.sessions.length - shown.length;
      const useTimeGroups = shown.length > 1;
      if (useTimeGroups) {
        const timeGroups = groupSessionsByActivity(shown, dateLocale, t, nowMs);
        for (const group of timeGroups) {
          for (const s of group.sessions) {
            rows.push({
              kind: "session",
              key: `s:${s.id}`,
              session: s,
              showActivity: true,
              inArchive: false,
              indent: showFolderHeaders,
            });
          }
        }
      } else {
        for (const s of shown) {
          rows.push({
            kind: "session",
            key: `s:${s.id}`,
            session: s,
            showActivity: true,
            inArchive: false,
            indent: showFolderHeaders,
          });
        }
      }
      if (hidden > 0) {
        rows.push({
          kind: "folder-more",
          key: `fm:${fkey}`,
          cwd: folder.cwd,
          fkey,
          hidden,
        });
      } else if (expandedFolders.has(fkey) && recentLimit > 0 && folder.sessions.length > recentLimit) {
        rows.push({ kind: "folder-fewer", key: `ff:${fkey}`, fkey });
      }
    }
    return rows;
  }, [
    treeSections,
    collapsedFolders,
    expandedFolders,
    recentLimit,
    // The cap always keeps the active chat, so switching chats re-cuts the list.
    activeSessionId,
    showFolderHeaders,
    dateLocale,
    t,
    nowMs,
    confirmDeleteFolderCwd,
  ]);

  const TREE_VIRT_THRESHOLD = 80;
  const treeVirtual = treeRows.length > TREE_VIRT_THRESHOLD;
  const sessionListRef = useRef<HTMLDivElement>(null);
  const treeVirtualizer = useVirtualizer({
    count: treeVirtual ? treeRows.length : 0,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => {
      const row = treeRows[index];
      if (!row) return 40;
      switch (row.kind) {
        case "folder-head":
          return 28;
        case "folder-empty":
          return 26;
        case "folder-more":
          return 28;
        case "folder-fewer":
          return 28;
        case "folder-confirm":
          return 84;
        case "board":
          return 28;
        case "session":
          return 34;
        case "archive-head":
        case "liked-head":
          return 32;
        case "liked":
          return 52;
      }
    },
    overscan: 8,
  });

  const renderSessionRow = (s: SessionDto, showActivity: boolean, inArchive = false) => {
    const isActive = s.id === activeSessionId;
    const away = s.id !== activeSessionId;
    // `waiting` means parked on the user (open question / permission prompt):
    // the row must not claim the agent is working (see sessionRowMark).
    const mark = sessionRowMark(s.status, away, Boolean(unseenFinishedTurns[s.id]));
    const inPane = chatSplitOn && chatPaneIds.length > 1 && chatPaneIds.includes(s.id);
    const isRenaming = renamingId === s.id;
    const menuOpen = menu?.id === s.id;
    const confirming = confirmDeleteId === s.id;
    const activityAt = sessionActivityAt(s);
    const activity =
      showActivity && activityAt
        ? formatRelativeActivity(activityAt, dateLocale, t, nowMs)
        : "";

    if (confirming) {
      return (
        <div
          key={s.id}
          ref={confirmRef}
          className={`${styles.sessionConfirm} ${isActive ? styles.sessionConfirmActive : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.deleteSessionTitle")}
        >
          <div className={styles.sessionConfirmCopy}>
            <div className={styles.sessionConfirmTitle}>{t("chat.deleteSessionTitle")}</div>
            <p className={styles.sessionConfirmText}>{t("chat.deleteSessionBody")}</p>
          </div>
          <div className={styles.sessionConfirmActions}>
            <button
              type="button"
              className={styles.sessionConfirmCancel}
              onClick={() => setConfirmDeleteId(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.sessionConfirmDelete}
              onClick={() => {
                setConfirmDeleteId(null);
                void deleteSession(s.id);
              }}
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      );
    }

    const isDragging = draggingSessionId === s.id;
    return (
      <div
        key={s.id}
        data-session-id={s.id}
        data-is-toplevel={!s.cwd ? "true" : "false"}
        className={`${styles.sessionItem} ${isActive || menuOpen ? styles.active : ""} ${
          inPane && !isActive ? styles.sessionInPane : ""
        } ${menuOpen ? styles.sessionMenuOpen : ""}${isDragging ? ` ${styles.sessionDragging}` : ""}`}
        onPointerDown={!s.cwd ? onSessionPointerDown(s) : (e) => {
          // Open from anywhere on the row — pin/archive/⋯ stop propagation.
          if (e.button !== 0) return;
          if (e.ctrlKey || e.metaKey) {
            void openSessionInNewPane(s.id);
            return;
          }
          // Touch: wait for click. pointerdown+closeSheet eats the scroll
          // gesture and treats the first contact as "open this chat".
          if (e.pointerType !== "mouse") return;
          openChat(s.id);
        }}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) return;
          // Click is suppressed after a scroll; mouse already opened above.
          if (isTouch || window.innerWidth < 900) openChat(s.id);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          startRenameSession(s);
        }}
        onContextMenu={(e) => openSessionMenu(e, s.id)}
      >
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className={styles.renameInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRenameSession()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRenameSession();
              if (e.key === "Escape") setRenamingId(null);
            }}
          />
        ) : (
          <>
            <button type="button" className={styles.sessionBtn}>
              <span className={styles.sessionTitle}>
                <span
                  className={styles.sessionTitleText}
                  title={sessionTreeDisplayTitle(s.title, s.provider, t("common.newChat"))}
                >
                  {sessionTreeDisplayTitle(s.title, s.provider, t("common.newChat"))}
                </span>
                {mark === "running" ? (
                  <span
                    className={styles.sessionRunning}
                    title={t("chat.sessionRunning")}
                    aria-label={t("chat.sessionRunning")}
                  >
                    <span className={styles.sessionRunningBar} />
                    <span className={styles.sessionRunningBar} />
                    <span className={styles.sessionRunningBar} />
                  </span>
                ) : mark === "waiting" ? (
                  // Static ring, deliberately not the animated equalizer: the
                  // agent is idle until the reader answers.
                  <span
                    className={styles.sessionWaiting}
                    title={t("chat.sessionWaiting")}
                    aria-label={t("chat.sessionWaiting")}
                  />
                ) : mark === "unseen" ? (
                  <span
                    className={styles.sessionUnseen}
                    title={t("chat.sessionUnseen")}
                    aria-label={t("chat.sessionUnseen")}
                  />
                ) : null}
              </span>
            </button>
            {s.provider && showProviderBadge(s.provider) ? (
              <span
                className={`${styles.sessionAgentBadge}${
                  isShellSession(s.provider) ? ` ${styles.sessionAgentBadgeShell}` : ""
                }${
                  !isShellSession(s.provider) && agentAvailability[s.provider] === false
                    ? ` ${styles.sessionAgentBadgeOff}`
                    : ""
                }`}
                title={harnessLabel(s.provider, adapters)}
              >
                {harnessLabel(s.provider, adapters)}
              </span>
            ) : null}
            <div className={styles.sessionRowActions}>
            <button
              type="button"
              className={`${styles.sessionRowAction} ${styles.sessionPin}`}
              title={s.pinned ? t("chat.unpin") : t("chat.pin")}
              aria-label={s.pinned ? t("chat.unpin") : t("chat.pin")}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void setSessionFlags(s.id, { pinned: !s.pinned });
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
                className={s.pinned ? styles.sessionActionFilled : undefined}
              >
                <path
                  d="M9.2 4h5.6l.6 4.8 2.6 2.2v2.6H6v-2.6l2.6-2.2.6-4.8Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M12 13.6V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className={`${styles.sessionRowAction} ${styles.sessionArchive}`}
              title={inArchive ? t("chat.unarchive") : t("chat.archive")}
              aria-label={inArchive ? t("chat.unarchive") : t("chat.archive")}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const next = !s.archived;
                void setSessionFlags(s.id, { archived: next });
                showToast(next ? t("common.toastArchived") : t("common.toastUnarchived"), {
                  tone: "info",
                  id: `archive-${s.id}`,
                });
              }}
            >
              {inArchive ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2M12 12v4.5m0 0-1.8-1.8m1.8 1.8 1.8-1.8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2M12 12v3.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
            </div>
            {activity ? (
              <span
                className={styles.sessionActivity}
                title={
                  activityAt
                    ? new Intl.DateTimeFormat(dateLocale, {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(new Date(activityAt))
                    : undefined
                }
              >
                {activity}
              </span>
            ) : null}
            {settings.chatTreeElements.includes("more") &&
            (settings.chatTreeMenu ?? []).length > 0 ? (
              <button
                type="button"
                className={styles.sessionMore}
                aria-label={t("common.chatMenu")}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  openSessionMenu(e, s.id);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.5" />
                  <circle cx="12" cy="12" r="1.5" />
                  <circle cx="19" cy="12" r="1.5" />
                </svg>
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  };

  /** Persist a folder order: optimistic local list, then the server. */
  const commitFolderOrder = (list: string[]) => {
    useAppStore.setState({ knownFolders: list });
    return reorderFolders(list.map((cwd, i) => ({ cwd, sortOrder: i })));
  };

  /** Move a folder one slot up/down — the keyboard/menu path to reordering. */
  const moveFolder = (cwd: string, dir: -1 | 1) => {
    const list = [...useAppStore.getState().knownFolders];
    const from = list.indexOf(cwd);
    const to = from + dir;
    if (from === -1 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to]!, list[from]!];
    void commitFolderOrder(list);
  };

  const canMoveFolder = (cwd: string, dir: -1 | 1) => {
    const list = useAppStore.getState().knownFolders;
    const to = list.indexOf(cwd) + dir;
    return to >= 0 && to < list.length;
  };

  const openBoardMenu = (e: ReactMouseEvent, board: BoardDto) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setConfirmDeleteId(null);
    setFolderMenu(null);
    setConfirmDeleteFolderCwd(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setBoardMenu({
      board,
      x: Math.max(12, Math.min(rect.right - 8, window.innerWidth - 215)),
      y: Math.min(rect.bottom + 6, window.innerHeight - 185),
    });
  };

  /**
   * Sidebar rows in display order: folders and boards share one sequence. A
   * board's `sortOrder` is its slot index in that sequence; folders keep their
   * own relative order and flow into the remaining slots. The "unfiled chats"
   * bucket rides last and never takes a slot of its own.
   */
  const treeSequence = (): TreeToken[] =>
    treeSections.map<TreeToken>((section) =>
      section.kind === "board"
        ? { kind: "board", id: section.board.id }
        : { kind: "folder", id: section.folder.cwd || NO_FOLDER_KEY },
    );

  /** The rows that can be reordered — everything but the pinned bucket. */
  const movableTreeTokens = (): TreeToken[] =>
    treeSequence().filter((token) => token.id !== NO_FOLDER_KEY);

  /** DOM selector/value for a row: the drop targets carry these keys. */
  const rowKey = (token: TreeToken) => (token.kind === "board" ? `b:${token.id}` : token.id);

  /** Persist each board's slot index in the given display sequence. */
  const persistBoardSlots = (sequence: TreeToken[]) => {
    const items = sequence
      .filter((token) => token.id !== NO_FOLDER_KEY)
      .flatMap((token, i) => (token.kind === "board" ? [{ id: token.id, sortOrder: i }] : []));
    return reorderBoards(items);
  };

  /**
   * Persist one combined order: the folder list and the board slots are two
   * views of the same row sequence, so a drop recomputes both.
   */
  const commitTreeOrder = (sequence: TreeToken[]) => {
    const folderKeys = sequence
      .filter((token) => token.kind === "folder" && token.id !== NO_FOLDER_KEY)
      .map((token) => token.id);
    void commitFolderOrder(folderKeys);
    void persistBoardSlots(sequence);
  };

  /** Move a board one slot up/down in the folder+board sequence. */
  const moveBoard = (boardId: string, dir: -1 | 1) => {
    const tokens = movableTreeTokens();
    const from = tokens.findIndex((token) => token.kind === "board" && token.id === boardId);
    const to = from + dir;
    if (from === -1 || to < 0 || to >= tokens.length) return;
    [tokens[from], tokens[to]] = [tokens[to]!, tokens[from]!];
    void persistBoardSlots(tokens);
  };

  const canMoveBoard = (boardId: string, dir: -1 | 1) => {
    const tokens = movableTreeTokens();
    const to = tokens.findIndex((token) => token.kind === "board" && token.id === boardId) + dir;
    return to >= 0 && to < tokens.length;
  };

  const commitBoardRename = () => {
    const id = renamingBoardId;
    setRenamingBoardId(null);
    const name = boardDraft.trim();
    if (id && name) void renameBoard(id, name);
  };

  /** The row under the point: a board row, else a folder head, else null. */
  const rowAtPoint = (x: number, y: number): { key: string; el: HTMLElement } | null => {
    for (const node of document.elementsFromPoint(x, y)) {
      const boardEl = node.closest("[data-board-id]") as HTMLElement | null;
      if (boardEl) return { key: `b:${boardEl.getAttribute("data-board-id")}`, el: boardEl };
      const folderEl = node.closest("[data-folder-cwd]") as HTMLElement | null;
      if (folderEl) return { key: folderEl.getAttribute("data-folder-cwd") ?? "", el: folderEl };
    }
    return null;
  };

  /**
   * Pointer drag for a tree row — a folder head or a board row. Mouse users
   * grab anywhere on the row; touch users grab the dedicated grip, because a
   * swipe starting on the row itself belongs to the list (the grip carries
   * `touch-action: none`). On release the dragged row lands above or below the
   * row under the pointer, and that one combined order is persisted: the folder
   * list and the board slots are two views of the same sequence.
   */
  const startRowDrag =
    (dragged: TreeToken, opts?: { grip?: boolean }) =>
    (e: ReactMouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
      if (dragged.kind === "folder" && !dragged.id) return; // the unfiled bucket is pinned
      if (e.button !== 0) return;
      if (!opts?.grip && (e as React.PointerEvent).pointerType !== "mouse") return;
      const target = e.target as HTMLElement;
      if (target.closest("input")) return;
      if (!opts?.grip && target.closest("button")) return;

      const el = e.currentTarget as HTMLElement;
      const pointerId = (e as React.PointerEvent).pointerId;
      const startY = e.clientY;
      const startX = e.clientX;
      const draggedKey = rowKey(dragged);
      let moved = false;
      let currentOverKey: string | null = null;
      let currentInsertPos: "above" | "below" | null = null;
      // The browser still fires a click on the pointerup that ends a drag.
      suppressRowClickRef.current = false;

      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        setDraggingRowKey(null);
        setDragOverKey(null);
        setDragInsertPosition(null);
        if (moved) suppressRowClickRef.current = true;
      };

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!moved) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
          moved = true;
          setDraggingRowKey(draggedKey);
        }

        const hit = rowAtPoint(ev.clientX, ev.clientY);
        // Hovering the row being dragged itself means "no target".
        if (hit && hit.key !== draggedKey) {
          const rect = hit.el.getBoundingClientRect();
          const position = ev.clientY < rect.top + rect.height / 2 ? "above" : "below";
          currentOverKey = hit.key;
          currentInsertPos = position;
          setDragOverKey(hit.key);
          setDragInsertPosition(position);
        } else {
          currentOverKey = null;
          currentInsertPos = null;
          setDragOverKey(null);
          setDragInsertPosition(null);
        }
      };

      /** A cancelled gesture (browser took over the touch) must drop the drag. */
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        finish();
      };

      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const over = currentOverKey;
        const pos = currentInsertPos;
        finish();

        if (!moved || !over || !pos) return;
        const sequence = treeSequence();
        const from = sequence.findIndex((token) => rowKey(token) === draggedKey);
        if (from === -1) return;
        const [landing] = sequence.splice(from, 1);
        const to = sequence.findIndex((token) => rowKey(token) === over);
        if (to === -1 || !landing) return;
        sequence.splice(pos === "above" ? to : to + 1, 0, landing);
        commitTreeOrder(sequence);
      };

      // Touch pointers keep streaming to this element via capture, so the
      // gesture survives leaving the header row.
      if (opts?.grip) {
        try {
          el.setPointerCapture(pointerId);
        } catch {
          // capture is best-effort (pointer may already be gone)
        }
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

  const onSessionPointerDown = (session: SessionDto) => (e: ReactMouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) => {
    if (session.cwd) return; // Only drag top-level sessions
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;

    const pointerId = (e as React.PointerEvent).pointerId;
    const startY = e.clientY;
    const startX = e.clientX;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        moved = true;
        setDraggingSessionId(session.id);
      }

      const elements = document.elementsFromPoint(ev.clientX, ev.clientY);
      let targetId: string | null = null;
      for (const el of elements) {
        const sessEl = el.closest("[data-session-id][data-is-toplevel='true']");
        if (sessEl) {
          targetId = sessEl.getAttribute("data-session-id");
          break;
        }
      }

      if (targetId && targetId !== session.id) {
        const list = [...useAppStore.getState().sessions];
        const idxA = list.findIndex((s) => s.id === session.id);
        const idxB = list.findIndex((s) => s.id === targetId);
        if (idxA !== -1 && idxB !== -1) {
          const temp = list[idxA];
          list[idxA] = list[idxB];
          list[idxB] = temp;
          useAppStore.setState({ sessions: list });
        }
      }
    };

    const onUp = async (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDraggingSessionId(null);

      if (moved) {
        const list = useAppStore.getState().sessions;
        const topLevel = list.filter((s) => !s.cwd);
        const items = topLevel.map((s, i) => ({
          id: s.id,
          themeId: s.themeId,
          sortOrder: i,
        }));
        await reorderSessions(items);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeFolderKey = useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    if (!active || active.archived) return null;
    return canonicalCwd(active.cwd) || NO_FOLDER_KEY;
  }, [sessions, activeSessionId]);

  /**
   * Mobile chat tree: the sheet opens at the top of the list, so the chat the
   * user is actually in (usually far down) had to be hunted for by scrolling.
   * Scroll the active row into view whenever the tree opens on a phone — once
   * per open, not on every row re-render (a running turn re-sorts the list).
   */
  const autoScrolledForOpen = useRef(false);
  useLayoutEffect(() => {
    if (!sidebarOpen || typeof window === "undefined" || window.innerWidth >= 900) {
      autoScrolledForOpen.current = false;
      return;
    }
    if (autoScrolledForOpen.current || !activeSessionId) return;
    const index = treeRows.findIndex(
      (row) => row.kind === "session" && row.session.id === activeSessionId,
    );
    // Active chat not in the tree yet (still loading, archived, or its folder
    // is collapsed) — leave the flag unset so a later render can retry.
    if (index === -1) return;
    autoScrolledForOpen.current = true;
    if (treeVirtual) {
      // Windowed rows are unmounted, so the element cannot be queried.
      treeVirtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    sessionListRef.current
      ?.querySelector<HTMLElement>(`[data-session-id="${activeSessionId}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [
    sidebarOpen,
    activeSessionId,
    treeRows,
    treeVirtual,
    treeVirtualizer,
    collapsedFolders,
    recentLimit,
  ]);

  const renderFolderHead = (folder: (typeof folders)[number]) => {
    const fkey = folder.cwd || NO_FOLDER_KEY;
    const isActiveFolder = activeFolderKey === fkey;
    const isDragging = draggingRowKey === fkey;
    const isDragOver = dragOverKey === fkey;
    const dragOverClass = isDragOver
      ? dragInsertPosition === "above"
        ? ` ${styles.folderHeadDragOverAbove}`
        : ` ${styles.folderHeadDragOverBelow}`
      : "";
    return (
      <div
        data-folder-cwd={fkey}
        onPointerDown={startRowDrag({ kind: "folder", id: folder.cwd })}
        className={`${styles.folderHead} ${
          collapsedFolders.has(fkey) ? "" : styles.folderHeadOpen
        }${isActiveFolder ? ` ${styles.folderHeadActive}` : ""}${isDragging ? ` ${styles.folderHeadDragging}` : ""}${dragOverClass}`}
        title={folder.cwd || undefined}
        onClick={() => {
          if (suppressRowClickRef.current) return;
          toggleFolder(fkey);
        }}
        onContextMenu={(e) => openFolderMenu(e, folder.cwd)}
      >
        {folder.cwd ? (
          <span
            className={styles.folderGrip}
            role="button"
            tabIndex={-1}
            data-folder-grip
            title={t("chat.reorderFolder")}
            aria-label={t("chat.reorderFolder")}
            onPointerDown={(e) => {
              e.stopPropagation();
              startRowDrag({ kind: "folder", id: folder.cwd }, { grip: true })(e);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
              <circle cx="2.5" cy="2.5" r="1.2" />
              <circle cx="7.5" cy="2.5" r="1.2" />
              <circle cx="2.5" cy="7" r="1.2" />
              <circle cx="7.5" cy="7" r="1.2" />
              <circle cx="2.5" cy="11.5" r="1.2" />
              <circle cx="7.5" cy="11.5" r="1.2" />
            </svg>
          </span>
        ) : null}
        <span className={styles.folderLead} aria-hidden>
          <span className={styles.folderChevronIcon}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className={styles.folderIcon}>
            <FolderGlyph />
          </span>
        </span>
        <span className={styles.folderLabel}>
          {folderLabel(folder.cwd, t("common.noFolder"))}
        </span>
        {folder.cwd ? (
          <button
            type="button"
            className={styles.folderDelete}
            title={t("chat.deleteFolder")}
            aria-label={t("chat.deleteFolder")}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDeleteFolderCwd(folder.cwd);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className={styles.folderAdd}
          title={t("chat.newInFolder")}
          aria-label={t("chat.newInFolder")}
          onClick={(e) => {
            e.stopPropagation();
            openFolderPicker({
              x: e.clientX,
              y: e.clientY,
              lockedCwd: folder.cwd || "",
            });
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {isTouch && folder.cwd ? (
          <button
            type="button"
            className={styles.folderMenuBtn}
            title={t("common.chatMenu")}
            aria-label={t("common.chatMenu")}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openFolderMenuAt(folder.cwd, rect.left, rect.bottom + 4, rect.top, rect.bottom);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>
        ) : null}
      </div>
    );
  };

  /** One folder group of the plain (unvirtualized) chat tree. */
  const renderFolderGroup = (folder: (typeof folders)[number]) => {
    if (folder.cwd && folder.cwd === confirmDeleteFolderCwd) {
      return renderFolderDeleteConfirm(folder.cwd);
    }
    const fkey = folder.cwd || NO_FOLDER_KEY;
    const isActiveFolder = activeFolderKey === fkey;
    const shown = visibleFolderSessions(folder);
    const hidden = folder.sessions.length - shown.length;
    const canCollapse =
      hidden === 0 &&
      expandedFolders.has(fkey) &&
      recentLimit > 0 &&
      folder.sessions.length > recentLimit;
    const useTimeGroups = shown.length > 1;
    const timeGroups = useTimeGroups
      ? groupSessionsByActivity(shown, dateLocale, t, nowMs)
      : null;

    return (
      <div key={fkey} className={styles.folderGroup}>
        {showFolderHeaders && renderFolderHead(folder)}
        {!collapsedFolders.has(fkey) && (
          <div
            className={`${showFolderHeaders ? styles.folderBody : styles.ungroupedSessions}${
              showFolderHeaders && isActiveFolder ? ` ${styles.folderBodyActive}` : ""
            }`}
          >
            {folder.sessions.length === 0 ? (
              <div className={styles.folderEmpty}>{t("chat.emptyFolder")}</div>
            ) : timeGroups ? (
              timeGroups.map((group) => (
                <div key={group.key} className={styles.timeGroup}>
                  {group.sessions.map((s) => renderSessionRow(s, true))}
                </div>
              ))
            ) : (
              shown.map((s) => renderSessionRow(s, true))
            )}
            {hidden > 0 ? (
              <button
                type="button"
                className={styles.folderMore}
                onClick={() => expandFolder(fkey)}
              >
                {t("chat.showMoreChats", { count: hidden })}
              </button>
            ) : canCollapse ? (
              <button
                type="button"
                className={styles.folderMore}
                onClick={() => collapseExpandedFolder(fkey)}
              >
                {t("chat.showFewerChats")}
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  const renderBoardRow = (board: BoardDto) => {
    const isActive = activeBoardId === board.id;
    const menuOpen = boardMenu?.board.id === board.id;
    const confirming = confirmDeleteBoardId === board.id;
    const isRenaming = renamingBoardId === board.id;
    const boardKey = `b:${board.id}`;
    const isDragging = draggingRowKey === boardKey;
    const isDragOver = dragOverKey === boardKey;
    const dragOverClass = isDragOver
      ? dragInsertPosition === "above"
        ? ` ${styles.folderHeadDragOverAbove}`
        : ` ${styles.folderHeadDragOverBelow}`
      : "";

    if (confirming) {
      return (
        <div
          key={board.id}
          ref={boardConfirmRef}
          className={styles.sessionConfirm}
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.deleteBoardTitle")}
        >
          <div className={styles.sessionConfirmCopy}>
            <div className={styles.sessionConfirmTitle}>{t("chat.deleteBoardTitle")}</div>
            <p className={styles.sessionConfirmText}>{t("chat.deleteBoardBody")}</p>
          </div>
          <div className={styles.sessionConfirmActions}>
            <button
              type="button"
              className={styles.sessionConfirmCancel}
              onClick={() => setConfirmDeleteBoardId(null)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.sessionConfirmDelete}
              onClick={() => {
                setConfirmDeleteBoardId(null);
                void deleteBoard(board.id);
                if (activeBoardId === board.id) navigate("/chat");
              }}
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        data-board-id={board.id}
        className={`${styles.folderHead} ${
          isActive || menuOpen ? styles.folderHeadActive : ""
        }${isDragging ? ` ${styles.folderHeadDragging}` : ""}${dragOverClass}`}
        title={board.name}
        onPointerDown={startRowDrag({ kind: "board", id: board.id })}
        onClick={() => {
          if (isRenaming || suppressRowClickRef.current) return;
          navigate(`/board/${board.id}`);
          closeMobile();
        }}
        onContextMenu={(e) => openBoardMenu(e, board)}
        onDoubleClick={(e) => {
          if (suppressRowClickRef.current) return;
          e.preventDefault();
          setBoardMenu(null);
          setBoardDraft(board.name);
          setRenamingBoardId(board.id);
        }}
      >
        <span
          className={styles.folderGrip}
          role="button"
          tabIndex={-1}
          data-board-grip
          title={t("chat.reorderFolder")}
          aria-label={t("chat.reorderFolder")}
          onPointerDown={(e) => {
            e.stopPropagation();
            startRowDrag({ kind: "board", id: board.id }, { grip: true })(e);
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
            <circle cx="2.5" cy="2.5" r="1.2" />
            <circle cx="7.5" cy="2.5" r="1.2" />
            <circle cx="2.5" cy="7" r="1.2" />
            <circle cx="7.5" cy="7" r="1.2" />
            <circle cx="2.5" cy="11.5" r="1.2" />
            <circle cx="7.5" cy="11.5" r="1.2" />
          </svg>
        </span>
        <span className={styles.folderLead} aria-hidden>
          <span className={styles.folderIcon}>
            <BoardGlyph />
          </span>
        </span>
        {isRenaming ? (
          <input
            className={styles.renameInput}
            value={boardDraft}
            autoFocus
            onChange={(e) => setBoardDraft(e.target.value)}
            onBlur={() => commitBoardRename()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitBoardRename();
              if (e.key === "Escape") setRenamingBoardId(null);
            }}
          />
        ) : (
          <span className={styles.folderLabel}>{board.name}</span>
        )}
        <button
          type="button"
          className={styles.folderDelete}
          title={t("common.delete")}
          aria-label={t("common.delete")}
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDeleteBoardId(board.id);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
  };

  const renderSectionHead = (
    sectionKey: "__archive__" | "__liked__",
    count: number,
    label: string,
  ) => (
    <div className={styles.archiveHead}>
      <button
        type="button"
        className={`${styles.archiveChevron} ${
          collapsedFolders.has(sectionKey) ? "" : styles.folderChevronOpen
        }`}
        title={
          collapsedFolders.has(sectionKey)
            ? t("chat.expandFolder")
            : t("chat.collapseFolder")
        }
        aria-label={
          collapsedFolders.has(sectionKey)
            ? t("chat.expandFolder")
            : t("chat.collapseFolder")
        }
        onClick={() => toggleFolder(sectionKey)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <span className={styles.archiveLabel}>{label}</span>
      <span className={styles.archiveCount}>{count}</span>
    </div>
  );

  const renderLikedItem = (item: LikedMessage) => (
    <button
      type="button"
      className={styles.likedItem}
      title={item.sessionTitle || undefined}
      onClick={() => {
        void selectSession(item.sessionId).then(() => {
          setFocusMessageId(item.messageId);
          goToChat();
        });
      }}
    >
      <span className={styles.likedText}>{item.text}</span>
      <span className={styles.likedMeta}>
        {item.sessionTitle || t("chat.likedUnknownSession")}
      </span>
    </button>
  );

  const renderTreeRow = (row: TreeRow): ReactNode => {
    switch (row.kind) {
      case "folder-head":
        return renderFolderHead(row.folder);
      case "folder-empty":
        return <div className={styles.folderEmpty}>{t("chat.emptyFolder")}</div>;
      case "folder-more":
        return (
          <button
            type="button"
            className={styles.folderMore}
            onClick={() => expandFolder(row.fkey)}
          >
            {t("chat.showMoreChats", { count: row.hidden })}
          </button>
        );
      case "folder-fewer":
        return (
          <button
            type="button"
            className={styles.folderMore}
            onClick={() => collapseExpandedFolder(row.fkey)}
          >
            {t("chat.showFewerChats")}
          </button>
        );
      case "folder-confirm":
        return renderFolderDeleteConfirm(row.cwd);
      case "board":
        return renderBoardRow(row.board);
      case "session":
        return renderSessionRow(row.session, row.showActivity, row.inArchive);
      case "archive-head":
        return renderSectionHead("__archive__", row.count, t("chat.archiveSection"));
      case "liked-head":
        return renderSectionHead("__liked__", row.count, t("chat.likedSection"));
      case "liked":
        return renderLikedItem(row.item);
    }
  };

  return (
    <>
      <div
        className={`${styles.chatPanel}${
          (settings.chatTreeElements ?? []).includes("pin") ? "" : ` ${styles.treeNoPin}`
        }${(settings.chatTreeElements ?? []).includes("archive") ? "" : ` ${styles.treeNoArchive}`}${
          (settings.chatTreeElements ?? []).includes("more") &&
          (settings.chatTreeMenu ?? []).length > 0
            ? ""
            : ` ${styles.treeNoMore}`
        }`}
      >
        <div
          className={`${styles.chatToolbar} ${
            toolbarMinimal ? styles.chatToolbarMinimal : styles.chatToolbarClassic
          }`}
        >
          <button
            className={toolbarMinimal ? styles.chatToolbarAction : styles.newChat}
            type="button"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              openFolderPicker({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
            {!toolbarMinimal ? (
              <span className={styles.newChatIcon} aria-hidden>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5.5 4.8h9.2A3.3 3.3 0 0 1 18 8.1v5.2a3.3 3.3 0 0 1-3.3 3.3H10l-3.4 2.6v-2.6H5.5A3.3 3.3 0 0 1 2.2 13.3V8.1A3.3 3.3 0 0 1 5.5 4.8Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M16.8 3.2 17.5 5.2 19.5 5.9 17.5 6.6 16.8 8.6 16.1 6.6 14.1 5.9 16.1 5.2 16.8 3.2Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5.5 4.8h9.2A3.3 3.3 0 0 1 18 8.1v5.2a3.3 3.3 0 0 1-3.3 3.3H10l-3.4 2.6v-2.6H5.5A3.3 3.3 0 0 1 2.2 13.3V8.1A3.3 3.3 0 0 1 5.5 4.8Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path
                  d="M16.8 3.2 17.5 5.2 19.5 5.9 17.5 6.6 16.8 8.6 16.1 6.6 14.1 5.9 16.1 5.2 16.8 3.2Z"
                  fill="currentColor"
                />
              </svg>
            )}
            <span className={toolbarMinimal ? undefined : styles.newChatLabel}>
              {t("common.newChat")}
            </span>
          </button>

          {isChatSearchEnabled(settings.chatTreeElements) && onOpenSearch ? (
            <button
              type="button"
              className={toolbarMinimal ? styles.chatToolbarAction : styles.chatSearchOpen}
              onClick={onOpenSearch}
              title={t("chat.searchDialogTitle")}
              aria-label={t("chat.searchDialogTitle")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M16 16l4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span>{t("chat.searchPlaceholder")}</span>
              {!toolbarMinimal ? (
                <kbd className={styles.chatSearchKbd} aria-hidden>
                  /
                </kbd>
              ) : null}
            </button>
          ) : null}
        </div>

        <div
          className={styles.sessionList}
          ref={sessionListRef}
        >
          {treeVirtual && (
            <div
              style={{
                height: treeVirtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
                // Absolute children contribute no content height, so the flex
                // column would shrink this container and cap the scroll area.
                flexShrink: 0,
              }}
            >
              {treeVirtualizer.getVirtualItems().map((vi) => {
                const row = treeRows[vi.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    data-index={vi.index}
                    ref={treeVirtualizer.measureElement}
                    className={
                      row.kind === "session" && row.indent
                        ? `${styles.treeVirtNested}${
                            activeFolderKey != null &&
                            (canonicalCwd(row.session.cwd) || NO_FOLDER_KEY) === activeFolderKey
                              ? ` ${styles.treeVirtNestedActive}`
                              : ""
                          }`
                        : undefined
                    }
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${vi.start}px)`,
                      paddingTop:
                        row.kind === "folder-head" && vi.index > 0 ? 16 : 0,
                      paddingBottom:
                        row.kind === "session"
                          ? 3
                          : row.kind === "folder-head"
                            ? 10
                            : row.kind === "folder-more"
                              ? 4
                              : 8,
                    }}
                  >
                    {renderTreeRow(row)}
                  </div>
                );
              })}
            </div>
          )}
          {!treeVirtual &&
            treeSections.map((section) =>
              section.kind === "board" ? (
                <div key={`b:${section.board.id}`} className={styles.folderGroup}>
                  {renderBoardRow(section.board)}
                </div>
              ) : (
                renderFolderGroup(section.folder)
              ),
            )}
          {archivedSessions.length > 0 && (
            <div className={styles.archiveGroup}>
              <div className={styles.archiveHead}>
                <button
                  type="button"
                  className={`${styles.archiveChevron} ${
                    collapsedFolders.has("__archive__") ? "" : styles.folderChevronOpen
                  }`}
                  title={
                    collapsedFolders.has("__archive__")
                      ? t("chat.expandFolder")
                      : t("chat.collapseFolder")
                  }
                  aria-label={
                    collapsedFolders.has("__archive__")
                      ? t("chat.expandFolder")
                      : t("chat.collapseFolder")
                  }
                  onClick={() => toggleFolder("__archive__")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <span className={styles.archiveLabel}>{t("chat.archiveSection")}</span>
                <span className={styles.archiveCount}>{archivedSessions.length}</span>
              </div>
              {!collapsedFolders.has("__archive__") && (
                <div className={styles.ungroupedSessions}>
                  {archivedSessions.map((s) => renderSessionRow(s, true, true))}
                </div>
              )}
            </div>
          )}
          {liked.length > 0 && (
            <div className={styles.likedGroup}>
              <div className={styles.archiveHead}>
                <button
                  type="button"
                  className={`${styles.archiveChevron} ${
                    collapsedFolders.has("__liked__") ? "" : styles.folderChevronOpen
                  }`}
                  title={
                    collapsedFolders.has("__liked__")
                      ? t("chat.expandFolder")
                      : t("chat.collapseFolder")
                  }
                  aria-label={
                    collapsedFolders.has("__liked__")
                      ? t("chat.expandFolder")
                      : t("chat.collapseFolder")
                  }
                  onClick={() => toggleFolder("__liked__")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M6 9l6 6 6-6"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <span className={styles.archiveLabel}>{t("chat.likedSection")}</span>
                <span className={styles.archiveCount}>{liked.length}</span>
              </div>
              {!collapsedFolders.has("__liked__") && (
                <div className={styles.likedList}>
                  {liked.map((item) => (
                    <button
                      key={item.messageId}
                      type="button"
                      className={styles.likedItem}
                      title={item.sessionTitle || undefined}
                      onClick={() => {
                        void selectSession(item.sessionId).then(() => {
                          setFocusMessageId(item.messageId);
                          goToChat();
                        });
                      }}
                    >
                      <span className={styles.likedText}>{item.text}</span>
                      <span className={styles.likedMeta}>
                        {item.sessionTitle || t("chat.likedUnknownSession")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {visibleSessions.length === 0 && (
            <p className={styles.emptyHint}>
              {t("chat.emptyDescription", {
                agents: harnessNamesForCopy(adapters, t("chat.emptyAgentsAny")),
              })}
            </p>
          )}
        </div>
      </div>

      {menu &&
        menuSession &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.contextMenu}
            style={{
              left: menuPos?.x ?? menu.x,
              top: menuPos?.y ?? menu.y,
              visibility: menuPos ? "visible" : "hidden",
            }}
            role="menu"
          >
            {(settings.chatTreeMenu ?? []).includes("rename") && (
            <button type="button" role="menuitem" onClick={() => startRenameSession(menuSession)}>
              <MenuIcon>
                <path
                  d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path d="M12.8 6.8 17.2 11.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </MenuIcon>
              {t("chat.renameSession")}
            </button>
            )}
            {(settings.chatTreeMenu ?? []).includes("move") && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const { x, y } = menu;
                openFolderPicker({
                  x,
                  y,
                  lockedCwd: menuSession.cwd?.trim() || "",
                });
              }}
            >
              <MenuIcon>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </MenuIcon>
              {t("chat.newInFolder")}
            </button>
            )}
            {isTouch && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void setSessionFlags(menuSession.id, { pinned: !menuSession.pinned });
                    setMenu(null);
                  }}
                >
                  <MenuIcon>
                    <path
                      d="M9.2 4h5.6l.6 4.8 2.6 2.2v2.6H6v-2.6l2.6-2.2.6-4.8Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <path d="M12 13.6V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </MenuIcon>
                  {menuSession.pinned ? t("chat.unpin") : t("chat.pin")}
                </button>
              </>
            )}
            {isTouch && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const next = !menuSession.archived;
                    void setSessionFlags(menuSession.id, { archived: next });
                    showToast(next ? t("common.toastArchived") : t("common.toastUnarchived"), {
                      tone: "info",
                      id: `archive-${menuSession.id}`,
                    });
                    setMenu(null);
                  }}
                >
                  <MenuIcon>
                    <path
                      d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2M12 12v4.5m0 0-1.8-1.8m1.8 1.8 1.8-1.8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </MenuIcon>
                  {menuSession.archived ? t("chat.unarchive") : t("chat.archive")}
                </button>
              </>
            )}
            {(settings.chatTreeMenu ?? []).includes("export") && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                setExportDialogId(menuSession.id);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.exportChat")}
            </button>
            )}
            {(settings.chatTreeMenu ?? []).includes("delete") && (
            <>
            <div className={styles.contextMenuDivider} aria-hidden />
            <button
              type="button"
              role="menuitem"
              className={styles.menuDanger}
              onClick={() => {
                setMenu(null);
                setConfirmDeleteId(menuSession.id);
              }}
            >
              <MenuIcon>
                <path
                  d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("common.delete")}
            </button>
            </>
            )}
          </div>,
          document.body,
        )}

      {folderMenu &&
        folderMenu.cwd &&
        createPortal(
          <div
            ref={folderMenuRef}
            className={styles.contextMenu}
            style={{
              left: folderMenuPos?.x ?? folderMenu.x,
              top: folderMenuPos?.y ?? folderMenu.y,
              visibility: folderMenuPos ? "visible" : "hidden",
            }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const cwd = folderMenu.cwd;
                setFolderMenu(null);
                openFolderPicker({
                  x: folderMenu.x,
                  y: folderMenu.y,
                  lockedCwd: cwd,
                });
              }}
            >
              <MenuIcon>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </MenuIcon>
              {t("chat.newInFolder")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveFolder(folderMenu.cwd, -1)}
              onClick={() => {
                moveFolder(folderMenu.cwd, -1);
                setFolderMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 19V5m0 0-6 6m6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.moveFolderUp")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveFolder(folderMenu.cwd, 1)}
              onClick={() => {
                moveFolder(folderMenu.cwd, 1);
                setFolderMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 5v14m0 0-6-6m6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.moveFolderDown")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={folderMenuActiveCount === 0}
              onClick={() => archiveFolderSessions(folderMenu.cwd)}
            >
              <MenuIcon>
                <path
                  d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M4.5 7.5V5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v2M12 12v4.5m0 0-1.8-1.8m1.8 1.8 1.8-1.8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.archiveAllInFolder")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const cwd = folderMenu.cwd;
                setFolderMenu(null);
                setMcpFolderCwd(cwd);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 3.5v10M8.5 7 12 10.5 15.5 7M8.5 13 12 16.5 15.5 13"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.mcpFolderMenu")}
            </button>
            <div className={styles.contextMenuDivider} aria-hidden />
            <button
              type="button"
              role="menuitem"
              className={styles.menuDanger}
              onClick={() => {
                const cwd = folderMenu.cwd;
                setFolderMenu(null);
                setConfirmDeleteFolderCwd(cwd);
              }}
            >
              <MenuIcon>
                <path
                  d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("common.delete")}
            </button>
          </div>,
          document.body,
        )}

      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          dialogStartPath={folderPicker.dialogStartPath ?? ""}
          lockedCwd={folderPicker.lockedCwd}
          recentCwds={recentCwds}
          agents={agentOptions}
          preferredProvider={settings.defaultProvider}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd, provider) => {
            setFolderPicker(null);
            await startNewSession(cwd, provider);
          }}
          onCreateBoard={async (name) => {
            const board = await createBoard(name);
            setFolderPicker(null);
            if (board) {
              // A fresh board lands at the bottom of the tree, below folders.
              const tokens = movableTreeTokens().filter(
                (token) => !(token.kind === "board" && token.id === board.id),
              );
              void persistBoardSlots([...tokens, { kind: "board", id: board.id }]);
              navigate(`/board/${board.id}`);
            }
          }}
          onOpenExisting={async (row) => {
            setFolderPicker(null);
            try {
              await importHarnessSession({
                provider: row.provider,
                acpSessionId: row.acpSessionId,
                cwd: row.cwd,
                title: row.title,
              });
              goToChat();
            } catch (err) {
              showToast(
                err instanceof Error && err.message === "alreadyInTree"
                  ? t("chat.alreadyInTree")
                  : err instanceof Error
                    ? err.message
                    : String(err),
                { tone: "danger" },
              );
            }
          }}
        />
      )}

      {boardMenu &&
        createPortal(
          <div
            ref={boardMenuRef}
            className={styles.contextMenu}
            style={{ left: boardMenu.x, top: boardMenu.y }}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setBoardDraft(boardMenu.board.name);
                setRenamingBoardId(boardMenu.board.id);
                setBoardMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M4 20h4.8L20 8.8 15.2 4 4 15.2V20Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path
                  d="M12.8 6.8 17.2 11.2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </MenuIcon>
              {t("chat.renameSession")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveBoard(boardMenu.board.id, -1)}
              onClick={() => {
                moveBoard(boardMenu.board.id, -1);
                setBoardMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 19V5m0 0-6 6m6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.moveFolderUp")}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!canMoveBoard(boardMenu.board.id, 1)}
              onClick={() => {
                moveBoard(boardMenu.board.id, 1);
                setBoardMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M12 5v14m0 0-6-6m6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("chat.moveFolderDown")}
            </button>
            <div className={styles.contextMenuDivider} aria-hidden />
            <button
              type="button"
              role="menuitem"
              className={styles.menuDanger}
              onClick={() => {
                setConfirmDeleteBoardId(boardMenu.board.id);
                setBoardMenu(null);
              }}
            >
              <MenuIcon>
                <path
                  d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </MenuIcon>
              {t("common.delete")}
            </button>
          </div>,
          document.body,
        )}

      {mcpFolderCwd &&
        createPortal(
          <McpFolderDialog
            open
            cwd={mcpFolderCwd}
            onClose={() => setMcpFolderCwd(null)}
          />,
          document.body,
        )}

      {exportDialogId &&
        createPortal(
          <ExportDialog
            open
            sessionId={exportDialogId}
            messageCount={undefined}
            onClose={() => setExportDialogId(null)}
          />,
          document.body,
        )}
    </>
  );
}
