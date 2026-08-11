import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import type { SessionDto } from "@acprocess/shared";
import { useT } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "./CreateSessionFolderPicker";
import styles from "./AppShell.module.css";

type MenuState = { id: string; x: number; y: number } | null;

type FolderPickerState = {
  x: number;
  y: number;
  dialogStartPath?: string;
};

function sortSessions(list: SessionDto[]) {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.lastMessageAt.localeCompare(a.lastMessageAt) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

function normalizeCwd(cwd: string | null | undefined) {
  return (cwd ?? "").trim().replace(/[\\/]+$/, "");
}

function folderLabel(cwd: string, noFolderLabel: string) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return noFolderLabel;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] || normalized;
  if (normalized.length <= 36) return normalized;
  return leaf.length <= 36 ? leaf : `…${leaf.slice(-34)}`;
}

function groupByFolder(list: SessionDto[]) {
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
    latest: sessions.reduce((max, s) => (s.lastMessageAt > max ? s.lastMessageAt : max), ""),
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

function formatRelativeActivity(
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
    const bucket = activityBucket(session.lastMessageAt || session.createdAt, locale, t, nowMs);
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

export function ChatSidebar({ focusSearchSignal = 0 }: { focusSearchSignal?: number }) {
  const t = useT();
  const navigate = useNavigate();
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const setSessionFlags = useAppStore((s) => s.setSessionFlags);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSearchSignal > 0) searchInputRef.current?.focus();
  }, [focusSearchSignal]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("acprocess.collapsedFolders.v1");
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggleFolder = (key: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem("acprocess.collapsedFolders.v1", JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );

  const query = searchQuery.trim().toLowerCase();
  const visibleSessions = useMemo(() => {
    if (!query) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(query) ||
        (s.cwd ?? "").toLowerCase().includes(query),
    );
  }, [sessions, query]);

  const archivedSessions = useMemo(
    () => sortSessions(visibleSessions.filter((s) => s.archived)),
    [visibleSessions],
  );
  const folders = useMemo(
    () => groupByFolder(visibleSessions.filter((s) => !s.archived)),
    [visibleSessions],
  );

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

  const openFolderPicker = (opts: { x: number; y: number; dialogStartPath?: string }) => {
    setMenu(null);
    setConfirmDeleteId(null);
    setFolderPicker({
      x: opts.x,
      y: opts.y,
      dialogStartPath: opts.dialogStartPath,
    });
  };

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menu && !confirmDeleteId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || confirmRef.current?.contains(target)) return;
      setMenu(null);
      setConfirmDeleteId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, confirmDeleteId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    confirmRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirmDeleteId]);

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
        : Math.min(rect.right - 8, window.innerWidth - 200);
    const y =
      e.type === "contextmenu"
        ? e.clientY
        : Math.min(rect.bottom + 6, window.innerHeight - 160);
    setMenu({ id, x, y });
  };

  const showFolderHeaders = folders.length > 1 || (folders.length === 1 && !!folders[0]?.cwd);
  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : null;
  const dateLocale = settings.locale === "en" ? "en-US" : "ru-RU";

  const renderSessionRow = (s: SessionDto, showActivity: boolean, inArchive = false) => {
    const isActive = s.id === activeSessionId;
    const isRenaming = renamingId === s.id;
    const menuOpen = menu?.id === s.id;
    const confirming = confirmDeleteId === s.id;
    const activity = showActivity
      ? formatRelativeActivity(s.lastMessageAt || s.createdAt, dateLocale, t, nowMs)
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
        className={`${styles.sessionItem} ${isActive || menuOpen ? styles.active : ""}`}
        onContextMenu={(e) => openSessionMenu(e, s.id)}
      >
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className={styles.renameInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRenameSession()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRenameSession();
              if (e.key === "Escape") setRenamingId(null);
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className={styles.sessionBtn}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                // Paint selection on press, before click/navigation.
                void selectSession(s.id);
              }}
              onClick={() => {
                goToChat();
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                startRenameSession(s);
              }}
            >
              <span className={styles.sessionTitle}>
                <span className={styles.sessionTitleText}>{s.title}</span>
                {(s.status === "running" || s.status === "waiting") &&
                  s.id !== activeSessionId && (
                    <span
                      className={styles.sessionRunning}
                      title={t("chat.sessionRunning")}
                      aria-label={t("chat.sessionRunning")}
                    >
                      <span className={styles.sessionRunningBar} />
                      <span className={styles.sessionRunningBar} />
                      <span className={styles.sessionRunningBar} />
                    </span>
                  )}
              </span>
            </button>
            <button
              type="button"
              className={styles.sessionRowAction}
              title={s.pinned ? t("chat.unpin") : t("chat.pin")}
              aria-label={s.pinned ? t("chat.unpin") : t("chat.pin")}
              onClick={(e) => {
                e.stopPropagation();
                void setSessionFlags(s.id, { pinned: !s.pinned });
              }}
            >
              <svg
                width="17"
                height="17"
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
              className={styles.sessionRowAction}
              title={inArchive ? t("chat.unarchive") : t("chat.archive")}
              aria-label={inArchive ? t("chat.unarchive") : t("chat.archive")}
              onClick={(e) => {
                e.stopPropagation();
                void setSessionFlags(s.id, { archived: !s.archived });
              }}
            >
              {inArchive ? (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
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
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
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
            {activity ? (
              <span
                className={styles.sessionActivity}
                title={new Intl.DateTimeFormat(dateLocale, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(s.lastMessageAt || s.createdAt))}
              >
                {activity}
              </span>
            ) : null}
            <button
              type="button"
              className={styles.sessionMore}
              aria-label={t("common.chatMenu")}
              onClick={(e) => openSessionMenu(e, s.id)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.5" />
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="19" cy="12" r="1.5" />
              </svg>
            </button>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <div className={styles.chatPanel}>
        <div className={styles.chatToolbar}>
          <button
            className={styles.newChat}
            type="button"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              openFolderPicker({ x: rect.left, y: rect.bottom + 6 });
            }}
          >
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
            <span className={styles.newChatLabel}>{t("common.newChat")}</span>
          </button>
        </div>

        <div className={styles.chatSearch}>
          <svg
            className={styles.chatSearchIcon}
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M16 16l4.5 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={searchInputRef}
            className={styles.chatSearchInput}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("chat.searchPlaceholder")}
            aria-label={t("chat.searchPlaceholder")}
          />
          {searchQuery ? (
            <button
              type="button"
              className={styles.chatSearchClear}
              aria-label={t("chat.clearSearch")}
              title={t("chat.clearSearch")}
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : null}
        </div>

        <div className={styles.sessionList}>
          {folders.map((folder) => {
            const useTimeGroups = folder.sessions.length > 1;
            const timeGroups = useTimeGroups
              ? groupSessionsByActivity(folder.sessions, dateLocale, t, nowMs)
              : null;

            return (
              <div key={folder.cwd || "__no_folder__"} className={styles.folderGroup}>
                {showFolderHeaders && (
                  <div
                    className={`${styles.folderHead} ${
                      collapsedFolders.has(folder.cwd || "__no_folder__") ? "" : styles.folderHeadOpen
                    }`}
                    title={folder.cwd || undefined}
                    onClick={() => toggleFolder(folder.cwd || "__no_folder__")}
                  >
                    <span className={styles.folderIconWrap} aria-hidden>
                      <span className={styles.folderIcon}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M3.5 8.5V7a2 2 0 0 1 2-2h4.2l1.6 1.7H18.5a2 2 0 0 1 2 2v1"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M3.5 10.2h17v6.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-6.3Z"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <span className={styles.folderChevronIcon}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M6 9l6 6 6-6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </span>
                    <span className={styles.folderLabel}>
                      {folderLabel(folder.cwd, t("common.noFolder"))}
                    </span>
                    <button
                      type="button"
                      className={styles.folderAdd}
                      title={t("chat.newInFolder")}
                      aria-label={t("chat.newInFolder")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void createSession(folder.cwd || undefined).then(() => goToChat());
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
                {!collapsedFolders.has(folder.cwd || "__no_folder__") &&
                  (timeGroups
                    ? timeGroups.map((group) => {
                        const sharedHeading = group.sessions.length > 1 && !!group.label;
                        return (
                          <div key={group.key} className={styles.timeGroup}>
                            {sharedHeading ? (
                              <div className={styles.timeGroupHead}>
                                <span className={styles.timeGroupLabel}>{group.label}</span>
                              </div>
                            ) : null}
                            {group.sessions.map((s) => renderSessionRow(s, !sharedHeading))}
                          </div>
                        );
                      })
                    : folder.sessions.map((s) => renderSessionRow(s, true)))}
              </div>
            );
          })}
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
              {!collapsedFolders.has("__archive__") &&
                archivedSessions.map((s) => renderSessionRow(s, true, true))}
            </div>
          )}
          {visibleSessions.length === 0 && (
            <p className={styles.emptyHint}>
              {query ? t("chat.searchEmpty") : t("chat.emptyDescription")}
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
            style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
            role="menu"
          >
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
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const { x, y } = menu;
                openFolderPicker({
                  x,
                  y,
                  dialogStartPath:
                    menuSession.cwd?.trim() || settings.defaultCwd?.trim() || "",
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
          </div>,
          document.body,
        )}

      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          dialogStartPath={folderPicker.dialogStartPath ?? ""}
          recentCwds={recentCwds}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd) => {
            setFolderPicker(null);
            await createSession(cwd);
          }}
        />
      )}
    </>
  );
}
