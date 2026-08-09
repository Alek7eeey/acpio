import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
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

type DropTarget = { sessionId: string };

type MenuState = { id: string; x: number; y: number } | null;

type PopoverState = { kind: "delete-session"; session: SessionDto; x: number; y: number } | null;

type FolderPickerState = {
  x: number;
  y: number;
  dialogStartPath?: string;
};

function sortSessions(list: SessionDto[]) {
  return [...list].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sortOrder - b.sortOrder,
  );
}

function clampPopover(x: number, y: number, width = 280, height = 160) {
  const margin = window.innerWidth < 480 ? 16 : 12;
  const maxW = Math.min(width, window.innerWidth - margin * 2);
  let left: number;
  if (window.innerWidth < 480) {
    left = Math.round((window.innerWidth - maxW) / 2);
  } else {
    left = Math.min(Math.max(margin, x), window.innerWidth - maxW - margin);
  }
  const top = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
  return { left, top, width: maxW };
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
    latest: sessions.reduce((max, s) => (s.updatedAt > max ? s.updatedAt : max), ""),
  }));
  entries.sort((a, b) => {
    if (!a.cwd && b.cwd) return 1;
    if (a.cwd && !b.cwd) return -1;
    if (a.latest !== b.latest) return b.latest.localeCompare(a.latest);
    return a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" });
  });
  return entries;
}

function formatRelativeActivity(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  nowMs: number,
) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffMs = Math.max(0, nowMs - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t("common.relativeJustNow");
  if (minutes < 60) return t("common.relativeMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.relativeHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("common.relativeDays", { count: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t("common.relativeWeeks", { count: weeks });
  const months = Math.floor(days / 30);
  if (months < 12) return t("common.relativeMonths", { count: months });
  const years = Math.max(1, Math.floor(days / 365));
  return t("common.relativeYears", { count: years });
}

export function ChatSidebar() {
  const t = useT();
  const navigate = useNavigate();
  const sessions = useAppStore((s) => s.sessions);
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const reorderSessions = useAppStore((s) => s.reorderSessions);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null);
  const [canDrag, setCanDrag] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const dragRef = useRef<{ sessionId: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setCanDrag(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );

  const folders = useMemo(() => groupByFolder(sessions), [sessions]);

  const closeMobile = () => {
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const openChat = async (sessionId: string) => {
    await selectSession(sessionId);
    navigate("/chat");
    closeMobile();
  };

  const openFolderPicker = (opts: { x: number; y: number; dialogStartPath?: string }) => {
    setMenu(null);
    setPopover(null);
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
    if (!menu && !popover) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setMenu(null);
      setPopover(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setPopover(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, popover]);

  useEffect(() => {
    if (!popover) return;
    popoverRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [popover]);

  const startRenameSession = (s: SessionDto) => {
    setMenu(null);
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

  const buildReorder = (sessionId: string, beforeId: string) => {
    const moving = sessions.find((s) => s.id === sessionId);
    const before = sessions.find((s) => s.id === beforeId);
    if (!moving || !before) return null;

    const folderKey = normalizeCwd(moving.cwd);
    if (normalizeCwd(before.cwd) !== folderKey) return null;

    const inFolder = sortSessions(
      sessions.filter((s) => normalizeCwd(s.cwd) === folderKey && s.id !== sessionId),
    );
    const idx = inFolder.findIndex((s) => s.id === beforeId);
    if (idx >= 0) inFolder.splice(idx, 0, moving);
    else inFolder.push(moving);

    return inFolder.map((s, i) => ({
      id: s.id,
      themeId: null as string | null,
      sortOrder: i,
    }));
  };

  const applyDrop = async (target: DropTarget) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (!drag || target.sessionId === drag.sessionId) return;
    const items = buildReorder(drag.sessionId, target.sessionId);
    if (items) await reorderSessions(items);
  };

  const openSessionMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderPicker(null);
    const x =
      e.type === "contextmenu"
        ? e.clientX
        : (e.currentTarget as HTMLElement).getBoundingClientRect().right - 8;
    const y =
      e.type === "contextmenu"
        ? e.clientY
        : (e.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4;
    setMenu({ id, x, y });
  };

  const showFolderHeaders = folders.length > 1 || (folders.length === 1 && !!folders[0]?.cwd);
  const menuSession = menu ? sessions.find((s) => s.id === menu.id) : null;

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
            {t("common.newChat")}
          </button>
        </div>

        <div className={styles.sessionList}>
          {folders.map((folder) => (
            <div key={folder.cwd || "__no_folder__"} className={styles.folderGroup}>
              {showFolderHeaders && (
                <div className={styles.folderHead} title={folder.cwd || undefined}>
                  <span className={styles.folderIcon} aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
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
                  <span className={styles.folderLabel}>
                    {folderLabel(folder.cwd, t("common.noFolder"))}
                  </span>
                </div>
              )}
              {folder.sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                const isRenaming = renamingId === s.id;
                const menuOpen = menu?.id === s.id;
                const dropBefore = dropTarget?.sessionId === s.id ? styles.dropBefore : "";
                const activity = formatRelativeActivity(s.updatedAt, t, nowMs);

                return (
                  <div
                    key={s.id}
                    className={`${styles.sessionItem} ${isActive || menuOpen ? styles.active : ""} ${dropBefore}`}
                    draggable={!isRenaming && canDrag}
                    onDragStart={(e: DragEvent) => {
                      dragRef.current = { sessionId: s.id };
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", s.id);
                      setMenu(null);
                    }}
                    onDragEnd={() => {
                      dragRef.current = null;
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTarget({ sessionId: s.id });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void applyDrop({ sessionId: s.id });
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
                          onClick={() => {
                            void openChat(s.id);
                          }}
                          onDoubleClick={(e) => {
                            if (!canDrag) return;
                            e.preventDefault();
                            startRenameSession(s);
                          }}
                        >
                          <span className={styles.sessionTitle}>{s.title}</span>
                          {activity ? (
                            <span className={styles.sessionActivity} title={s.updatedAt}>
                              {activity}
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          className={styles.sessionMore}
                          aria-label={t("common.chatMenu")}
                          onClick={(e) => openSessionMenu(e, s.id)}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <circle cx="5" cy="12" r="1.8" />
                            <circle cx="12" cy="12" r="1.8" />
                            <circle cx="19" cy="12" r="1.8" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {sessions.length === 0 && <p className={styles.emptyHint}>{t("chat.emptyDescription")}</p>}
        </div>
      </div>

      {menu &&
        menuSession &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.contextMenu}
            style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}
            role="menu"
          >
            <button type="button" role="menuitem" onClick={() => startRenameSession(menuSession)}>
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
              {t("common.newChat")}
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.menuDanger}
              onClick={() => {
                const { x, y } = menu;
                setMenu(null);
                setPopover({ kind: "delete-session", session: menuSession, x, y });
              }}
            >
              {t("common.delete")}
            </button>
          </div>,
          document.body,
        )}

      {popover &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.actionPopover}
            style={clampPopover(popover.x, popover.y, 280, 170)}
            role="dialog"
            aria-modal="true"
          >
            <div className={styles.popoverTitle}>{t("chat.deleteSessionTitle")}</div>
            <p className={styles.popoverText}>{t("chat.deleteSessionBody")}</p>
            <div className={styles.popoverActions}>
              <button type="button" onClick={() => setPopover(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={styles.popoverDanger}
                onClick={() => {
                  const id = popover.session.id;
                  setPopover(null);
                  void deleteSession(id);
                }}
              >
                {t("common.delete")}
              </button>
            </div>
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
            navigate("/chat");
            closeMobile();
          }}
        />
      )}
    </>
  );
}
