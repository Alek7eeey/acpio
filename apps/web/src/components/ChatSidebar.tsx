import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { AgentProvider, SessionDto } from "@acpio/shared";
import { useT } from "../lib/i18n";
import { harnessShortLabel } from "../lib/harness";
import { isShellSession } from "@acpio/shared";
import { sessionTreeDisplayTitle } from "../lib/sessionTitle";
import { normalizeCwd } from "../lib/pathSegments";
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
import styles from "./AppShell.module.css";

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

function sortSessions(list: SessionDto[]) {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      sessionActivityAt(b).localeCompare(sessionActivityAt(a)) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

/** Last user message time, or creation time when the chat is still empty. */
export function sessionActivityAt(session: Pick<SessionDto, "lastMessageAt" | "createdAt">): string {
  return session.lastMessageAt || session.createdAt;
}

function folderLabel(cwd: string, noFolderLabel: string) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return noFolderLabel;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

export function groupByFolder(list: SessionDto[]) {
  const map = new Map<string, SessionDto[]>();
  for (const s of list) {
    const key = normalizeCwd(s.cwd);
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  const entries = [...map.entries()].map(([cwd, sessions]) => ({
    cwd,
    sessions: sortSessions(sessions),
    latest: sessions.reduce(
      (max, s) => {
        const key = sessionActivityAt(s);
        return key > max ? key : max;
      },
      "",
    ),
  }));
  entries.sort((a, b) => {
    if (a.latest !== b.latest) return b.latest.localeCompare(a.latest);
    if (!a.cwd && b.cwd) return 1;
    if (a.cwd && !b.cwd) return -1;
    return a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" });
  });
  return entries;
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
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const setSessionFlags = useAppStore((s) => s.setSessionFlags);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const setFocusMessageId = useAppStore((s) => s.setFocusMessageId);

  const agentOptions = useMemo(
    () =>
      (adapters.length
        ? adapters.map((a) => ({ id: a.id, label: a.label }))
        : [
            { id: "cursor" as AgentProvider, label: "Cursor" },
            { id: "omp" as AgentProvider, label: "OMP" },
          ]
      ).map((a) => ({ ...a, online: agentAvailability[a.id] === true })),
    [adapters, agentAvailability],
  );

  const [liked, setLiked] = useState<LikedMessage[]>(() => listLikedMessages());
  useEffect(() => subscribeLikedMessages(() => setLiked(listLikedMessages())), []);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportDialogId, setExportDialogId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null);
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

  // Folders that have (or had) chats, persisted on the server so empty
  // folders survive deleting the last chat and are visible from any device.
  const knownFolders = useAppStore((s) => s.knownFolders);
  const deleteFolder = useAppStore((s) => s.deleteFolder);

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
  const folderMenuRef = useRef<HTMLDivElement>(null);

  const openFolderMenu = (e: ReactMouseEvent, cwd: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(null);
    setConfirmDeleteId(null);
    setConfirmDeleteFolderCwd(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setFolderMenuPos(null);
    setFolderMenu({
      cwd,
      x: e.clientX,
      y: e.clientY,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
    });
  };

  const commitDeleteFolder = (cwd: string) => {
    setConfirmDeleteFolderCwd(null);
    void deleteFolder(cwd);
    showToast(t("chat.folderDeleted"), { tone: "info" });
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
  // Track newly added sessions (e.g. a freshly created chat) so the sidebar
  // can play a subtle entrance animation on just that row, not the whole list.
  const prevSessionIds = useRef<Set<string> | null>(null);
  const enteringSessionIds = useRef<Set<string>>(new Set());
  const currentSessionIds = sessions.map((s) => s.id);
  const prevIds = prevSessionIds.current;
  if (prevIds === null) {
    // Seed on first render so existing sessions don't animate on mount.
    prevSessionIds.current = new Set(currentSessionIds);
  } else {
    for (const id of currentSessionIds) {
      if (!prevIds.has(id)) enteringSessionIds.current.add(id);
    }
    prevSessionIds.current = new Set(currentSessionIds);
  }

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
    const grouped = groupByFolder(visibleSessions.filter((s) => !s.archived));
    const groupedKeys = new Set(grouped.map((f) => f.cwd));
    const empties = knownFolders
      .filter((cwd) => !groupedKeys.has(cwd))
      .map((cwd) => ({ cwd, sessions: [] as SessionDto[], latest: "" }));
    if (empties.length === 0) return grouped;
    return [...grouped, ...empties];
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
    if (!menu && !confirmDeleteId && !folderMenu && !confirmDeleteFolderCwd) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        confirmRef.current?.contains(target) ||
        folderMenuRef.current?.contains(target) ||
        folderConfirmRef.current?.contains(target)
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
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, confirmDeleteId, folderMenu, confirmDeleteFolderCwd]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteId]);

  useEffect(() => {
    if (!confirmDeleteFolderCwd) return;
    folderConfirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteFolderCwd]);

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

  // ── Tree virtualization ────────────────────────────────────────────────────
  // The sidebar can accumulate hundreds of sessions; beyond a threshold the
  // tree is flattened into rows and windowed with @tanstack/react-virtual.
  // Small trees keep the plain render (no measurement/scroll subtleties).
  type TreeRow =
    | { kind: "folder-head"; key: string; folder: (typeof folders)[number] }
    | { kind: "folder-empty"; key: string; cwd: string }
    | { kind: "folder-confirm"; key: string; cwd: string }
    | { kind: "session"; key: string; session: SessionDto; showActivity: boolean; inArchive: boolean; indent: boolean }
    | { kind: "archive-head"; key: string; count: number }
    | { kind: "liked-head"; key: string; count: number }
    | { kind: "liked"; key: string; item: LikedMessage };

  const treeRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const noFolder = "__no_folder__";
    for (const folder of folders) {
      const fkey = folder.cwd || noFolder;
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
      const useTimeGroups = folder.sessions.length > 1;
      if (useTimeGroups) {
        const timeGroups = groupSessionsByActivity(folder.sessions, dateLocale, t, nowMs);
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
        for (const s of folder.sessions) {
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
    }
    return rows;
  }, [folders, collapsedFolders, showFolderHeaders, dateLocale, t, nowMs, confirmDeleteFolderCwd]);

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
        case "folder-confirm":
          return 84;
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

  // FLIP-animate tree rows only when session *order* actually changes
  // (e.g. promote after a finished turn). Layout noise from Stop / status
  // badges / relative-time text must not trigger motion.
  const treeOrderKey = useMemo(
    () =>
      treeRows
        .filter((r): r is Extract<TreeRow, { kind: "session" }> => r.kind === "session")
        .map((r) => r.session.id)
        .join("\n"),
    [treeRows],
  );
  const treeFlipTops = useRef<Map<string, number>>(new Map());
  const prevTreeOrderKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = sessionListRef.current;
    if (!root || treeVirtual) {
      treeFlipTops.current = new Map();
      prevTreeOrderKey.current = treeOrderKey;
      return;
    }
    const nodes = root.querySelectorAll<HTMLElement>("[data-tree-flip]");
    const next = new Map<string, number>();
    nodes.forEach((el) => {
      const key = el.dataset.treeFlip;
      if (!key) return;
      next.set(key, el.getBoundingClientRect().top);
    });

    const orderChanged =
      prevTreeOrderKey.current != null && prevTreeOrderKey.current !== treeOrderKey;
    prevTreeOrderKey.current = treeOrderKey;

    if (!orderChanged) {
      treeFlipTops.current = next;
      return;
    }

    const moving: { el: HTMLElement; dy: number }[] = [];
    nodes.forEach((el) => {
      const key = el.dataset.treeFlip;
      if (!key) return;
      const top = next.get(key);
      const prev = treeFlipTops.current.get(key);
      if (top == null || prev == null) return;
      const dy = prev - top;
      // Ignore tiny shifts — only real reorder slides.
      if (Math.abs(dy) > 6) moving.push({ el, dy });
    });
    treeFlipTops.current = next;
    if (!moving.length) return;

    for (const { el, dy } of moving) {
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
    }
    void root.offsetHeight;
    for (const { el } of moving) {
      el.style.transition = "transform 0.48s cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "";
    }
    const clearId = window.setTimeout(() => {
      for (const { el } of moving) {
        el.style.transition = "";
      }
    }, 520);
    return () => window.clearTimeout(clearId);
  }, [treeRows, treeVirtual, treeOrderKey]);

  const renderSessionRow = (s: SessionDto, showActivity: boolean, inArchive = false) => {
    const isActive = s.id === activeSessionId;
    const away = s.id !== activeSessionId;
    const showRunning = away && (s.status === "running" || s.status === "waiting");
    const showUnseen = away && !showRunning && Boolean(unseenFinishedTurns[s.id]);
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

    return (
      <div
        key={s.id}
        data-tree-flip={`s:${s.id}`}
        className={`${styles.sessionItem} ${isActive || menuOpen ? styles.active : ""} ${
          inPane && !isActive ? styles.sessionInPane : ""
        } ${
          menuOpen ? styles.sessionMenuOpen : ""
        } ${enteringSessionIds.current.has(s.id) ? styles.entering : ""}`}
        onPointerDown={(e) => {
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
                {(showRunning || showUnseen) && (
                  showRunning ? (
                    <span
                      className={styles.sessionRunning}
                      title={t("chat.sessionRunning")}
                      aria-label={t("chat.sessionRunning")}
                    >
                      <span className={styles.sessionRunningBar} />
                      <span className={styles.sessionRunningBar} />
                      <span className={styles.sessionRunningBar} />
                    </span>
                  ) : (
                    <span
                      className={styles.sessionUnseen}
                      title={t("chat.sessionUnseen")}
                      aria-label={t("chat.sessionUnseen")}
                    />
                  )
                )}
              </span>
            </button>
            {s.provider ? (
              <span
                className={`${styles.sessionAgentBadge}${
                  isShellSession(s.provider) ? ` ${styles.sessionAgentBadgeShell}` : ""
                }${
                  !isShellSession(s.provider) && agentAvailability[s.provider] === false
                    ? ` ${styles.sessionAgentBadgeOff}`
                    : ""
                }`}
                title={harnessShortLabel(s.provider)}
              >
                {harnessShortLabel(s.provider)}
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

  const noFolderKey = "__no_folder__";
  const activeFolderKey = useMemo(() => {
    const active = sessions.find((s) => s.id === activeSessionId);
    if (!active || active.archived) return null;
    return normalizeCwd(active.cwd) || noFolderKey;
  }, [sessions, activeSessionId]);

  const renderFolderHead = (folder: (typeof folders)[number]) => {
    const fkey = folder.cwd || noFolderKey;
    const isActiveFolder = activeFolderKey === fkey;
    return (
      <div
        className={`${styles.folderHead} ${
          collapsedFolders.has(fkey) ? "" : styles.folderHeadOpen
        }${isActiveFolder ? ` ${styles.folderHeadActive}` : ""}`}
        title={folder.cwd || undefined}
        onClick={() => toggleFolder(fkey)}
        onContextMenu={(e) => openFolderMenu(e, folder.cwd)}
      >
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
      case "folder-confirm":
        return renderFolderDeleteConfirm(row.cwd);
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
                            (normalizeCwd(row.session.cwd) || noFolderKey) === activeFolderKey
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
                            : 8,
                    }}
                  >
                    {renderTreeRow(row)}
                  </div>
                );
              })}
            </div>
          )}
          {!treeVirtual && (
            <>
          {folders.map((folder) => {
            if (folder.cwd && folder.cwd === confirmDeleteFolderCwd) {
              return renderFolderDeleteConfirm(folder.cwd);
            }
            const useTimeGroups = folder.sessions.length > 1;
            const timeGroups = useTimeGroups
              ? groupSessionsByActivity(folder.sessions, dateLocale, t, nowMs)
              : null;
            const fkey = folder.cwd || "__no_folder__";
            const isActiveFolder = activeFolderKey === fkey;

            return (
              <div
                key={fkey}
                className={styles.folderGroup}
                data-tree-flip={`fg:${fkey}`}
              >
                {showFolderHeaders && (
                  <div
                    className={`${styles.folderHead} ${
                      collapsedFolders.has(fkey) ? "" : styles.folderHeadOpen
                    }${isActiveFolder ? ` ${styles.folderHeadActive}` : ""}`}
                    title={folder.cwd || undefined}
                    onClick={() => toggleFolder(fkey)}
                    onContextMenu={(e) => openFolderMenu(e, folder.cwd)}
                  >
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
                  </div>
                )}
                {!collapsedFolders.has(fkey) && (
                  <div
                    className={`${
                      showFolderHeaders ? styles.folderBody : styles.ungroupedSessions
                    }${
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
                      folder.sessions.map((s) => renderSessionRow(s, true))
                    )}
                  </div>
                )}
              </div>
            );
          })}
            </>
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
              {t("chat.emptyDescription")}
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
