import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ChatThemeDto, SessionDto } from "@acprocess/shared";
import { useAppStore } from "../lib/store";
import {
  collectRecentCwds,
  CreateSessionFolderPicker,
} from "./CreateSessionFolderPicker";
import styles from "./AppShell.module.css";

type DropTarget =
  | { kind: "theme"; themeId: string | null }
  | { kind: "before"; sessionId: string; themeId: string | null };

type MenuState =
  | { kind: "session"; id: string; x: number; y: number }
  | { kind: "theme"; id: string; x: number; y: number }
  | null;

type PopoverState =
  | { kind: "create-theme"; x: number; y: number }
  | { kind: "delete-theme"; theme: ChatThemeDto; x: number; y: number }
  | { kind: "delete-session"; session: SessionDto; x: number; y: number }
  | null;

type FolderPickerState = {
  x: number;
  y: number;
  themeId?: string | null;
  dialogStartPath?: string;
};

function sortSessions(list: SessionDto[]) {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.updatedAt.localeCompare(b.updatedAt));
}

function clampPopover(
  x: number,
  y: number,
  width = 280,
  height = 160,
  align: "left" | "right" = "left",
) {
  const margin = window.innerWidth < 480 ? 16 : 12;
  const maxW = Math.min(width, window.innerWidth - margin * 2);
  let left: number;
  if (window.innerWidth < 480) {
    // Center on phones so a right-side trigger doesn't pin the sheet to the edge.
    left = Math.round((window.innerWidth - maxW) / 2);
  } else {
    left = align === "right" ? x - maxW : x;
    left = Math.min(Math.max(margin, left), window.innerWidth - maxW - margin);
  }
  const top = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
  return { left, top, width: maxW };
}

function normalizeCwd(cwd: string | null | undefined) {
  return (cwd ?? "").trim().replace(/[\\/]+$/, "");
}

function folderLabel(cwd: string) {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return "Без папки";
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
  }));
  entries.sort((a, b) => {
    if (!a.cwd && b.cwd) return 1;
    if (a.cwd && !b.cwd) return -1;
    return a.cwd.localeCompare(b.cwd, undefined, { sensitivity: "base" });
  });
  return entries;
}

export function ChatSidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const themes = useAppStore((s) => s.themes);
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeSession = useAppStore((s) => s.activeSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const reorderSessions = useAppStore((s) => s.reorderSessions);
  const createTheme = useAppStore((s) => s.createTheme);
  const renameTheme = useAppStore((s) => s.renameTheme);
  const deleteTheme = useAppStore((s) => s.deleteTheme);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingThemeId, setRenamingThemeId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [themeName, setThemeName] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [folderPicker, setFolderPicker] = useState<FolderPickerState | null>(null);
  const dragRef = useRef<{ sessionId: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const recentCwds = useMemo(
    () => collectRecentCwds(sessions, settings.defaultCwd),
    [sessions, settings.defaultCwd],
  );

  const dialogStartPath = () =>
    activeSession?.cwd?.trim() || settings.defaultCwd?.trim() || "";

  const openFolderPicker = (opts: {
    x: number;
    y: number;
    themeId?: string | null;
    dialogStartPath?: string;
  }) => {
    setMenu(null);
    setPopover(null);
    setFolderPicker({
      x: opts.x,
      y: opts.y,
      themeId: opts.themeId,
      dialogStartPath: opts.dialogStartPath ?? dialogStartPath(),
    });
  };

  useEffect(() => {
    if ((renamingId || renamingThemeId) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId, renamingThemeId]);

  useEffect(() => {
    if (!menu && !popover) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || popoverRef.current?.contains(t)) return;
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
    const input = popoverRef.current?.querySelector<HTMLInputElement>("input");
    if (input) {
      input.focus();
      input.select();
      return;
    }
    popoverRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [popover]);

  const byTheme = useMemo(() => {
    const map = new Map<string | null, SessionDto[]>();
    for (const t of themes) map.set(t.id, []);
    map.set(null, []);
    for (const s of sessions) {
      const key = s.themeId && map.has(s.themeId) ? s.themeId : null;
      map.get(key)!.push(s);
    }
    for (const [k, list] of map) map.set(k, sortSessions(list));
    return map;
  }, [sessions, themes]);

  const closeMobile = () => {
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const startRenameSession = (s: SessionDto) => {
    setMenu(null);
    setRenamingThemeId(null);
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

  const startRenameTheme = (t: ChatThemeDto) => {
    setMenu(null);
    setRenamingId(null);
    setRenamingThemeId(t.id);
    setDraft(t.name);
  };

  const commitRenameTheme = async () => {
    if (!renamingThemeId) return;
    const id = renamingThemeId;
    const name = draft.trim();
    setRenamingThemeId(null);
    if (name) await renameTheme(id, name);
  };

  const buildReorder = (sessionId: string, targetThemeId: string | null, beforeId?: string) => {
    const moving = sessions.find((s) => s.id === sessionId);
    if (!moving) return null;

    const groups = new Map<string | null, SessionDto[]>();
    for (const t of themes) groups.set(t.id, []);
    groups.set(null, []);

    for (const s of sessions) {
      if (s.id === sessionId) continue;
      const key = s.themeId && groups.has(s.themeId) ? s.themeId : null;
      groups.get(key)!.push(s);
    }
    for (const [k, list] of groups) groups.set(k, sortSessions(list));

    const dest = [...(groups.get(targetThemeId) ?? [])];
    if (beforeId) {
      const idx = dest.findIndex((s) => s.id === beforeId);
      if (idx >= 0) dest.splice(idx, 0, { ...moving, themeId: targetThemeId });
      else dest.push({ ...moving, themeId: targetThemeId });
    } else {
      dest.push({ ...moving, themeId: targetThemeId });
    }
    groups.set(targetThemeId, dest);

    const items: Array<{ id: string; themeId: string | null; sortOrder: number }> = [];
    for (const [themeId, list] of groups) {
      list.forEach((s, i) => {
        items.push({ id: s.id, themeId, sortOrder: i });
      });
    }
    return items;
  };

  const applyDrop = async (target: DropTarget) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDropTarget(null);
    if (!drag) return;

    if (target.kind === "theme") {
      const items = buildReorder(drag.sessionId, target.themeId);
      if (items) await reorderSessions(items);
      return;
    }

    if (target.sessionId === drag.sessionId) return;
    const items = buildReorder(drag.sessionId, target.themeId, target.sessionId);
    if (items) await reorderSessions(items);
  };

  const openSessionMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderPicker(null);
    const x = e.type === "contextmenu" ? e.clientX : (e.currentTarget as HTMLElement).getBoundingClientRect().right - 8;
    const y = e.type === "contextmenu" ? e.clientY : (e.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4;
    setMenu({ kind: "session", id, x, y });
  };

  const openThemeMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderPicker(null);
    const x = e.type === "contextmenu" ? e.clientX : (e.currentTarget as HTMLElement).getBoundingClientRect().left;
    const y = e.type === "contextmenu" ? e.clientY : (e.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4;
    setMenu({ kind: "theme", id, x, y });
  };

  const renderSession = (s: SessionDto, themeId: string | null) => {
    const isActive = s.id === activeSessionId;
    const isRenaming = renamingId === s.id;
    const menuOpen = menu?.kind === "session" && menu.id === s.id;
    const dropBefore =
      dropTarget?.kind === "before" && dropTarget.sessionId === s.id ? styles.dropBefore : "";

    return (
      <div
        key={s.id}
        className={`${styles.sessionItem} ${isActive || menuOpen ? styles.active : ""} ${dropBefore}`}
        draggable={!isRenaming}
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
          setDropTarget({ kind: "before", sessionId: s.id, themeId });
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void applyDrop({ kind: "before", sessionId: s.id, themeId });
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
                void selectSession(s.id);
                closeMobile();
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                startRenameSession(s);
              }}
            >
              <span className={styles.sessionTitle}>{s.title}</span>
            </button>
            <button
              type="button"
              className={styles.sessionMore}
              aria-label="Меню чата"
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
  };

  const renderThemeBranch = (theme: ChatThemeDto | null) => {
    const themeId = theme?.id ?? null;
    const key = theme?.id ?? "__ungrouped__";
    const list = byTheme.get(themeId) ?? [];
    if (!theme && list.length === 0) return null;

    const label = theme?.name ?? "Без темы";
    const isDropTheme =
      dropTarget?.kind === "theme" && dropTarget.themeId === themeId ? styles.dropTheme : "";
    const isRenaming = theme && renamingThemeId === theme.id;
    const folders = groupByFolder(list);
    const showFolderHeaders = folders.length > 1 || (folders.length === 1 && !!folders[0]?.cwd);

    return (
      <section
        key={key}
        className={`${styles.chatTheme} ${!theme ? styles.chatThemeUngrouped : ""} ${isDropTheme}`}
      >
        <div
          className={styles.chatThemeHead}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget({ kind: "theme", themeId });
          }}
          onDrop={(e) => {
            e.preventDefault();
            void applyDrop({ kind: "theme", themeId });
          }}
          onContextMenu={(e) => {
            if (theme) openThemeMenu(e, theme.id);
          }}
        >
          <div className={styles.chatThemeMeta}>
            <div className={styles.chatThemeTitleRow}>
              {isRenaming ? (
                <input
                  ref={renameInputRef}
                  className={styles.renameInputInline}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRenameTheme()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitRenameTheme();
                    if (e.key === "Escape") setRenamingThemeId(null);
                  }}
                />
              ) : (
                <h3
                  className={styles.chatThemeLabel}
                  onDoubleClick={() => {
                    if (theme) startRenameTheme(theme);
                  }}
                >
                  {label}
                </h3>
              )}
            </div>
          </div>
          {theme && (
            <button
              type="button"
              className={styles.themeMore}
              aria-label="Меню темы"
              onClick={(e) => openThemeMenu(e, theme.id)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
          )}
        </div>

        <div
          className={styles.chatThemeBody}
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget({ kind: "theme", themeId });
          }}
          onDrop={(e) => {
            e.preventDefault();
            void applyDrop({ kind: "theme", themeId });
          }}
        >
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
                  <span className={styles.folderLabel}>{folderLabel(folder.cwd)}</span>
                </div>
              )}
              {folder.sessions.map((s) => renderSession(s, themeId))}
            </div>
          ))}
          {theme && list.length === 0 && (
            <p className={styles.themeEmpty}>Перетащите чат сюда или создайте новый</p>
          )}
        </div>
      </section>
    );
  };

  const menuSession = menu?.kind === "session" ? sessions.find((s) => s.id === menu.id) : null;
  const menuTheme = menu?.kind === "theme" ? themes.find((t) => t.id === menu.id) : null;

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
            Новый чат
          </button>
          <button
            className={styles.newTheme}
            type="button"
            title="Добавить тему"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
              setThemeName("");
              setMenu(null);
              setFolderPicker(null);
              setPopover({ kind: "create-theme", x: rect.right, y: rect.bottom + 6 });
            }}
          >
            + Тема
          </button>
        </div>

        <div className={styles.sessionList}>
          {themes.map((t) => renderThemeBranch(t))}
          {renderThemeBranch(null)}
          {themes.length === 0 && sessions.length === 0 && (
            <p className={styles.emptyHint}>Создайте чат или тему для группировки</p>
          )}
        </div>
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className={styles.contextMenu}
            style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}
            role="menu"
          >
            {menu.kind === "session" && menuSession && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => startRenameSession(menuSession)}
                >
                  Переименовать
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { x, y } = menu;
                    openFolderPicker({
                      x,
                      y,
                      themeId: menuSession.themeId,
                      dialogStartPath:
                        menuSession.cwd?.trim() ||
                        settings.defaultCwd?.trim() ||
                        "",
                    });
                  }}
                >
                  Новый чат рядом
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
                  Удалить
                </button>
              </>
            )}
            {menu.kind === "theme" && menuTheme && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const { x, y } = menu;
                    openFolderPicker({
                      x,
                      y,
                      themeId: menuTheme.id,
                    });
                  }}
                >
                  Новый чат
                </button>
                <button type="button" role="menuitem" onClick={() => startRenameTheme(menuTheme)}>
                  Переименовать
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuDanger}
                  onClick={() => {
                    const { x, y } = menu;
                    setMenu(null);
                    setPopover({ kind: "delete-theme", theme: menuTheme, x, y });
                  }}
                >
                  Удалить тему
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {popover &&
        createPortal(
          <div
            ref={popoverRef}
            className={styles.actionPopover}
            style={clampPopover(
              popover.x,
              popover.y,
              280,
              popover.kind === "create-theme" ? 190 : 170,
              popover.kind === "create-theme" ? "right" : "left",
            )}
            role="dialog"
            aria-modal="true"
          >
            {popover.kind === "create-theme" && (
              <>
                <div className={styles.popoverTitle}>Новая тема</div>
                <p className={styles.popoverText}>Тема — ярлык для группировки чатов.</p>
                <input
                  className={styles.popoverInput}
                  value={themeName}
                  onChange={(e) => setThemeName(e.target.value)}
                  placeholder="Название"
                  maxLength={80}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const name = themeName.trim() || undefined;
                      setPopover(null);
                      void createTheme({ name });
                    }
                  }}
                />
                <div className={styles.popoverActions}>
                  <button type="button" onClick={() => setPopover(null)}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className={styles.popoverPrimary}
                    onClick={() => {
                      const name = themeName.trim() || undefined;
                      setPopover(null);
                      void createTheme({ name });
                    }}
                  >
                    Создать
                  </button>
                </div>
              </>
            )}

            {popover.kind === "delete-theme" && (
              <>
                <div className={styles.popoverTitle}>Удалить тему?</div>
                <p className={styles.popoverText}>
                  «{popover.theme.name}» исчезнет. Чаты останутся без темы.
                </p>
                <div className={styles.popoverActions}>
                  <button type="button" onClick={() => setPopover(null)}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className={styles.popoverDanger}
                    onClick={() => {
                      const id = popover.theme.id;
                      setPopover(null);
                      void deleteTheme(id);
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </>
            )}

            {popover.kind === "delete-session" && (
              <>
                <div className={styles.popoverTitle}>Удалить чат?</div>
                <p className={styles.popoverText}>
                  «{popover.session.title}» будет удалён без восстановления.
                </p>
                <div className={styles.popoverActions}>
                  <button type="button" onClick={() => setPopover(null)}>
                    Отмена
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
                    Удалить
                  </button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}

      {folderPicker && (
        <CreateSessionFolderPicker
          x={folderPicker.x}
          y={folderPicker.y}
          defaultCwd={settings.defaultCwd ?? ""}
          dialogStartPath={folderPicker.dialogStartPath}
          recentCwds={recentCwds}
          onClose={() => setFolderPicker(null)}
          onConfirm={async (cwd) => {
            const themeId = folderPicker.themeId;
            setFolderPicker(null);
            await createSession(themeId, cwd);
            closeMobile();
          }}
        />
      )}
    </>
  );
}
