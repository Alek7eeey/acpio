import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { boardColumn, type AgentProvider, type BoardColumn, type SessionDto } from "@acpio/shared";
import { McpFolderDialog } from "../components/McpFolderDialog";
import { ServerFolderBrowseDialog } from "../components/ServerFolderBrowseDialog";
import { readComposerDraft, setComposerDraft } from "../lib/composerDrafts";
import { useT } from "../lib/i18n";
import { folderLabel } from "../lib/pathSegments";
import { useAppStore } from "../lib/store";
import styles from "./BoardPage.module.css";

/** Column order on the board — the same order the spec's four lanes read in. */
const COLUMN_ORDER: BoardColumn[] = ["todo", "progress", "wait", "done"];

const COLUMN_TITLE = {
  todo: "chat.colTodo",
  progress: "chat.colProgress",
  wait: "chat.colWait",
  done: "chat.colDone",
} as const;

type TodoGroup = { cwd: string; label: string; loose: boolean; tasks: SessionDto[] };

export function BoardPage({ boardId: boardIdProp }: { boardId?: string } = {}) {
  // The shell hands the id over as a prop; the route element inside <Routes>
  // reaches it through params. Both exist because AppShell switches pages by
  // pathname, while the route tree only keeps the path from falling through.
  const { boardId: routeBoardId = "" } = useParams();
  const boardId = boardIdProp ?? routeBoardId;
  const navigate = useNavigate();
  const t = useT();

  const boards = useAppStore((s) => s.boards);
  const board = boards.find((b) => b.id === boardId) ?? null;
  const tasks = useAppStore((s) => s.boardSessions);
  const defaultCwd = useAppStore((s) => s.settings.defaultCwd ?? "");
  const adapters = useAppStore((s) => s.adapters);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const refreshBoardSessions = useAppStore((s) => s.refreshBoardSessions);
  const createBoardTask = useAppStore((s) => s.createBoardTask);
  const setTaskDone = useAppStore((s) => s.setTaskDone);
  const setTaskProvider = useAppStore((s) => s.setTaskProvider);
  const deleteBoardTask = useAppStore((s) => s.deleteBoardTask);
  const setBoardFolders = useAppStore((s) => s.setBoardFolders);
  const reorderBoardTasks = useAppStore((s) => s.reorderBoardTasks);
  const selectSession = useAppStore((s) => s.selectSession);

  const [filterCwd, setFilterCwd] = useState<string | null>(null);
  const [addingCwd, setAddingCwd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [agentMenu, setAgentMenu] = useState<{ task: SessionDto; x: number; y: number } | null>(
    null,
  );
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [mcpCwd, setMcpCwd] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SessionDto | null>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railDragRef = useRef<{ startY: number; lastY: number } | null>(null);

  useEffect(() => {
    if (boardId) void refreshBoardSessions(boardId);
  }, [boardId, refreshBoardSessions]);

  // A board that vanished (deleted elsewhere) must not strand the user here.
  useEffect(() => {
    if (boards.length && !board) navigate("/chat", { replace: true });
  }, [boards, board, navigate]);

  // The composer only exists while a group has it open.
  useEffect(() => {
    if (!addingCwd) return;
    composerRef.current?.focus();
  }, [addingCwd]);

  useEffect(() => {
    if (!railOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRailOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [railOpen]);

  useEffect(() => {
    if (!agentMenu) return;
    const onDown = (e: MouseEvent) => {
      if (agentMenuRef.current?.contains(e.target as Node)) return;
      setAgentMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAgentMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [agentMenu]);

  const columns = useMemo(() => {
    const byColumn: Record<BoardColumn, SessionDto[]> = {
      todo: [],
      progress: [],
      wait: [],
      done: [],
    };
    for (const task of tasks) byColumn[boardColumn(task)].push(task);
    for (const column of COLUMN_ORDER) {
      byColumn[column].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
      );
    }
    return byColumn;
  }, [tasks]);

  /** Todo lanes group by project; unknown cwds (folder removed from the board) trail. */
  const groups = useMemo<TodoGroup[]>(() => {
    const out: TodoGroup[] = [];
    const seen = new Set<string>();
    const push = (cwd: string, loose: boolean) => {
      if (seen.has(cwd)) return;
      seen.add(cwd);
      out.push({
        cwd,
        label: folderLabel(cwd, cwd),
        loose,
        tasks: columns.todo.filter((task) => task.cwd === cwd),
      });
    };
    for (const cwd of board?.folders ?? []) push(cwd, false);
    for (const task of columns.todo) push(task.cwd, true);
    return out.filter((group) => !group.loose || group.tasks.length > 0);
  }, [board, columns.todo]);

  const visibleGroups = filterCwd ? groups.filter((group) => group.cwd === filterCwd) : groups;

  /**
   * Open a task in the normal chat. The task description is seeded into the
   * composer draft (never sent): the first turn starts when the user presses
   * Enter, exactly like any other chat.
   */
  const openTask = async (task: SessionDto, provider?: AgentProvider) => {
    if (provider && provider !== task.provider) await setTaskProvider(task.id, provider);
    const description = task.taskDescription?.trim();
    if (description && !readComposerDraft(task.id)) setComposerDraft(task.id, description);
    await selectSession(task.id);
    navigate("/chat");
  };

  const submitNewTask = async (cwd: string) => {
    const description = draft.trim();
    if (!description || creating) return;
    setCreating(true);
    const created = await createBoardTask({ boardId, cwd, description });
    setCreating(false);
    if (!created) return; // keep the form so nothing the user typed is lost
    setDraft("");
    setAddingCwd(null);
  };

  const moveGroup = (cwd: string, dir: -1 | 1) => {
    const folders = [...(board?.folders ?? [])];
    const from = folders.indexOf(cwd);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= folders.length) return;
    [folders[from], folders[to]] = [folders[to], folders[from]];
    void setBoardFolders(boardId, folders);
  };

  const moveTask = (list: SessionDto[], task: SessionDto, dir: -1 | 1) => {
    const from = list.findIndex((item) => item.id === task.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return;
    const next = [...list];
    [next[from], next[to]] = [next[to], next[from]];
    void reorderBoardTasks(
      next.map((item, index) => ({ id: item.id, themeId: item.themeId, sortOrder: index })),
    );
  };

  /**
   * The mobile rail is a bottom sheet, so it has to answer the swipe-down
   * gesture a sheet is expected to answer. Dragging follows the pointer live
   * through a CSS variable and dismisses past a third of the sheet's height.
   */
  const onRailGrabberDown = (e: React.PointerEvent<HTMLElement>) => {
    const el = railRef.current;
    if (!el || window.innerWidth >= 900) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    railDragRef.current = { startY: e.clientY, lastY: e.clientY };
    el.dataset.dragging = "true";
  };

  const onRailGrabberMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    const el = railRef.current;
    if (!drag || !el) return;
    drag.lastY = e.clientY;
    const dy = Math.max(0, e.clientY - drag.startY);
    el.style.setProperty("--rail-drag", `${dy}px`);
  };

  const onRailGrabberUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = railDragRef.current;
    const el = railRef.current;
    railDragRef.current = null;
    if (!drag || !el) return;
    delete el.dataset.dragging;
    el.style.removeProperty("--rail-drag");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    const dy = Math.max(0, drag.lastY - drag.startY);
    if (dy > Math.max(64, el.offsetHeight / 3)) setRailOpen(false);
  };

  const openAgentMenu = (e: React.MouseEvent, task: SessionDto) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAgentMenu({
      task,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 240)),
      y: Math.min(rect.bottom + 6, window.innerHeight - 260),
    });
  };

  const renderCard = (task: SessionDto, group: TodoGroup | null) => {
    const column = boardColumn(task);
    const index = group ? group.tasks.findIndex((item) => item.id === task.id) : -1;
    const text = task.taskDescription?.trim() || task.title;
    return (
      <article
        key={task.id}
        data-task-id={task.id}
        className={`${styles.card} ${column === "progress" ? styles.cardLive : ""}`}
        onClick={() => void openTask(task)}
      >
        <div className={styles.cardTop}>
          <span className={styles.chip} title={task.cwd}>
            {folderLabel(task.cwd, task.cwd)}
          </span>
          <span className={styles.cardSpacer} />
          <span className={styles.cardActions}>
            {column === "todo" ? (
              <>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconStart}`}
                  title={t("chat.boardStart")}
                  aria-label={t("chat.boardStart")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openTask(task);
                  }}
                  onContextMenu={(e) => openAgentMenu(e, task)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
                    <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
                  </svg>
                </button>
                {group && !group.loose ? (
                  <>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      disabled={index <= 0}
                      title={t("chat.moveFolderUp")}
                      aria-label={t("chat.moveFolderUp")}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveTask(group.tasks, task, -1);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="m6 14 6-6 6 6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      disabled={index < 0 || index >= group.tasks.length - 1}
                      title={t("chat.moveFolderDown")}
                      aria-label={t("chat.moveFolderDown")}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveTask(group.tasks, task, 1);
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="m6 10 6 6 6-6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconDanger}`}
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(task);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </span>
        </div>
        <p className={styles.cardText}>{text}</p>
        {column === "progress" ? (
          <span className={styles.liveRow}>
            <span className={styles.pulse} aria-hidden />
            {t("chat.colProgress")}
          </span>
        ) : null}
        {column === "wait" ? (
          <button
            type="button"
            className={styles.doneToggle}
            onClick={(e) => {
              e.stopPropagation();
              void setTaskDone(task.id, true);
            }}
          >
            {t("chat.boardMarkDone")}
          </button>
        ) : null}
        {column === "done" ? (
          <button
            type="button"
            className={styles.doneToggle}
            onClick={(e) => {
              e.stopPropagation();
              void setTaskDone(task.id, false);
            }}
          >
            {t("chat.boardReopen")}
          </button>
        ) : null}
      </article>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.headerTitle}>{board?.name ?? ""}</span>
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.headerBtn}
          onClick={() => setFoldersOpen(true)}
        >
          {t("chat.boardFoldersTitle")}
        </button>
      </header>

      <div className={styles.body}>
        {railOpen ? (
          <button
            type="button"
            className={styles.railScrim}
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setRailOpen(false)}
          />
        ) : null}
        <aside
          ref={railRef}
          className={`${styles.rail} ${railOpen ? styles.railOpen : ""}`}
        >
          {/* Mobile sheet handle: the rail is pulled up from the bottom there,
              so it must be draggable back down. */}
          <span
            className={styles.railGrabber}
            aria-hidden="true"
            onPointerDown={onRailGrabberDown}
            onPointerMove={onRailGrabberMove}
            onPointerUp={onRailGrabberUp}
            onPointerCancel={onRailGrabberUp}
          />
          <div className={styles.railList}>
            <button
              type="button"
              data-rail-all=""
              className={`${styles.railItem} ${filterCwd === null ? styles.railItemOn : ""}`}
              onClick={() => {
                setFilterCwd(null);
                setRailOpen(false);
              }}
            >
              <span className={styles.railLabel}>{t("chat.boardAllProjects")}</span>
              <span className={styles.railCount}>{tasks.length}</span>
            </button>
            {groups.map((group) => (
              <div
                key={group.cwd}
                data-rail-cwd={group.cwd}
                className={`${styles.railRow} ${filterCwd === group.cwd ? styles.railRowOn : ""}`}
              >
                <button
                  type="button"
                  className={styles.railItem}
                  title={group.cwd}
                  onClick={() => {
                    setFilterCwd(filterCwd === group.cwd ? null : group.cwd);
                    setRailOpen(false);
                  }}
                >
                  <span className={styles.railLabel}>{group.label}</span>
                  <span className={styles.railCount}>
                    {tasks.filter((task) => task.cwd === group.cwd).length}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.railAdd}
                  title={t("chat.boardAddTask")}
                  aria-label={t("chat.boardAddTask")}
                  onClick={() => {
                    setFilterCwd(group.cwd);
                    setAddingCwd(group.cwd);
                    setRailOpen(false);
                  }}
                >
                  +
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles.railAddFolder}
              onClick={() => {
                setFoldersOpen(true);
                setRailOpen(false);
              }}
            >
              {t("chat.boardAddFolder")}
            </button>
          </div>
        </aside>

        <div className={styles.columns}>
          {COLUMN_ORDER.map((column) => {
            const cards = filterCwd
              ? columns[column].filter((task) => task.cwd === filterCwd)
              : columns[column];
            return (
              <section key={column} className={styles.column} data-column={column}>
                <div className={styles.columnHead}>
                  <span>{t(COLUMN_TITLE[column])}</span>
                  <span className={styles.columnCount}>{cards.length}</span>
                </div>
                <div className={styles.columnBody}>
                  {column === "todo"
                    ? visibleGroups.map((group, groupIndex) => (
                        <div key={group.cwd} className={styles.group} data-group={group.cwd}>
                          <div className={styles.groupHead}>
                            <span className={styles.groupName} title={group.cwd}>
                              {group.label}
                            </span>
                            <span className={styles.groupCount}>{group.tasks.length}</span>
                            <span className={styles.groupSpacer} />
                            <span className={styles.groupActions}>
                              {!group.loose ? (
                                <>
                                  <button
                                    type="button"
                                    className={styles.iconBtn}
                                    disabled={groupIndex === 0}
                                    title={t("chat.moveFolderUp")}
                                    aria-label={t("chat.moveFolderUp")}
                                    onClick={() => moveGroup(group.cwd, -1)}
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      aria-hidden
                                    >
                                      <path
                                        d="m6 14 6-6 6 6"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.iconBtn}
                                    disabled={groupIndex === visibleGroups.length - 1}
                                    title={t("chat.moveFolderDown")}
                                    aria-label={t("chat.moveFolderDown")}
                                    onClick={() => moveGroup(group.cwd, 1)}
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      aria-hidden
                                    >
                                      <path
                                        d="m6 10 6 6 6-6"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  </button>
                                </>
                              ) : null}
                              <button
                                type="button"
                                className={styles.iconBtn}
                                title={t("chat.boardAddTask")}
                                aria-label={t("chat.boardAddTask")}
                                onClick={() => {
                                  setAddingCwd(group.cwd);
                                  setDraft("");
                                }}
                              >
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  aria-hidden
                                >
                                  <path
                                    d="M12 5v14M5 12h14"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                  />
                                </svg>
                              </button>
                            </span>
                          </div>
                          {addingCwd === group.cwd ? (
                            <div className={styles.composer}>
                              <textarea
                                ref={composerRef}
                                className={styles.composerInput}
                                value={draft}
                                placeholder={t("chat.boardTaskPlaceholder")}
                                aria-label={t("chat.boardTaskPlaceholder")}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void submitNewTask(group.cwd);
                                  }
                                  if (e.key === "Escape") {
                                    setAddingCwd(null);
                                    setDraft("");
                                  }
                                }}
                              />
                              <div className={styles.composerActions}>
                                <button
                                  type="button"
                                  className={styles.ghostBtn}
                                  onClick={() => {
                                    setAddingCwd(null);
                                    setDraft("");
                                  }}
                                >
                                  {t("common.cancel")}
                                </button>
                                <button
                                  type="button"
                                  className={styles.primaryBtn}
                                  disabled={!draft.trim() || creating}
                                  onClick={() => void submitNewTask(group.cwd)}
                                >
                                  {t("common.create")}
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {group.tasks.map((task) => renderCard(task, group))}
                        </div>
                      ))
                    : cards.map((task) => renderCard(task, null))}
                  {column === "todo" && !visibleGroups.length ? (
                    <p className={styles.empty}>{t("chat.boardNoFolders")}</p>
                  ) : null}
                  {column !== "todo" && !cards.length ? (
                    <p className={styles.empty}>{t("chat.boardNoTasks")}</p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {/* Mobile only: both actions live under the thumb instead of the top
          corners, where a one-handed grip cannot reach them. */}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.actionBtn} ${
            railOpen || filterCwd !== null ? styles.actionBtnOn : ""
          }`}
          aria-expanded={railOpen}
          onClick={() => setRailOpen((open) => !open)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M4 5.5h6l1.6 2H20v11H4z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
          <span className={styles.actionLabel}>
            {filterCwd ? folderLabel(filterCwd, filterCwd) : t("chat.boardProjects")}
          </span>
        </button>
        <button
          type="button"
          className={styles.actionBtn}
          onClick={() => setFoldersOpen(true)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect
              x="3.5"
              y="5"
              width="17"
              height="14"
              rx="2.4"
              stroke="currentColor"
              strokeWidth="1.7"
            />
            <path
              d="M9.5 5v14M14.5 5v14"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          <span className={styles.actionLabel}>{t("chat.boardFoldersTitle")}</span>
        </button>
      </div>

      {agentMenu &&
        createPortal(
          <div
            ref={agentMenuRef}
            className={styles.menu}
            style={{ left: agentMenu.x, top: agentMenu.y }}
            role="menu"
          >
            <div className={styles.menuHead}>{t("chat.boardStartOther")}</div>
            {adapters.map((adapter) => (
              <button
                key={adapter.id}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  const task = agentMenu.task;
                  setAgentMenu(null);
                  void openTask(task, adapter.id);
                }}
              >
                <span
                  className={`${styles.dot} ${
                    agentAvailability[adapter.id] ? styles.dotOn : styles.dotOff
                  }`}
                  aria-hidden
                />
                {adapter.label}
              </button>
            ))}
          </div>,
          document.body,
        )}

      {foldersOpen &&
        createPortal(
          <div className={styles.backdrop} onClick={() => setFoldersOpen(false)}>
            <div
              className={styles.modal}
              role="dialog"
              aria-modal="true"
              aria-label={t("chat.boardFoldersTitle")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalTitle}>{t("chat.boardFoldersTitle")}</div>
              {board?.folders.length ? (
                <div className={styles.folderList}>
                  {board.folders.map((cwd) => (
                    <div key={cwd} className={styles.folderRow}>
                      <span className={styles.folderPath} title={cwd}>
                        {cwd}
                      </span>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        title={t("chat.mcpFolderMenu")}
                        aria-label={t("chat.mcpFolderMenu")}
                        onClick={() => setMcpCwd(cwd)}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <rect
                            x="3.5"
                            y="4"
                            width="17"
                            height="7"
                            rx="1.6"
                            stroke="currentColor"
                            strokeWidth="1.7"
                          />
                          <rect
                            x="3.5"
                            y="13"
                            width="17"
                            height="7"
                            rx="1.6"
                            stroke="currentColor"
                            strokeWidth="1.7"
                          />
                          <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
                          <circle cx="7.5" cy="16.5" r="1" fill="currentColor" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconDanger}`}
                        title={t("chat.boardRemoveFolder")}
                        aria-label={t("chat.boardRemoveFolder")}
                        onClick={() =>
                          void setBoardFolders(
                            boardId,
                            (board?.folders ?? []).filter((item) => item !== cwd),
                          )
                        }
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M6 6l12 12M18 6 6 18"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.modalText}>{t("chat.boardNoFolders")}</p>
              )}
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => setBrowseOpen(true)}
                >
                  {t("chat.boardAddFolder")}
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => setFoldersOpen(false)}
                >
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {confirmDelete &&
        createPortal(
          <div className={styles.backdrop} onClick={() => setConfirmDelete(null)}>
            <div
              className={styles.modal}
              role="dialog"
              aria-modal="true"
              aria-label={t("chat.deleteSessionTitle")}
              onClick={(e) => e.stopPropagation()}
            >
              <div className={styles.modalTitle}>{t("chat.deleteSessionTitle")}</div>
              <p className={styles.modalText}>{t("chat.deleteSessionBody")}</p>
              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  onClick={() => setConfirmDelete(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => {
                    const id = confirmDelete.id;
                    setConfirmDelete(null);
                    void deleteBoardTask(id);
                  }}
                >
                  {t("common.delete")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {mcpCwd &&
        createPortal(
          <McpFolderDialog open cwd={mcpCwd} onClose={() => setMcpCwd(null)} />,
          document.body,
        )}

      <ServerFolderBrowseDialog
        open={browseOpen}
        initialPath={defaultCwd}
        onClose={() => setBrowseOpen(false)}
        onSelect={(path) => {
          const folders = board?.folders ?? [];
          setBrowseOpen(false);
          if (!folders.includes(path)) void setBoardFolders(boardId, [...folders, path]);
        }}
      />
    </div>
  );
}
