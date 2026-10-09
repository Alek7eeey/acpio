import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { boardColumn, type AgentProvider, type BoardColumn, type SessionDto } from "@acpio/shared";
import { CreateSessionFolderPicker } from "../components/CreateSessionFolderPicker";
import { ExportDialog } from "../components/ExportDialog";
import { McpFolderDialog } from "../components/McpFolderDialog";
import { OptionPicker } from "../components/OptionPicker";
import { ServerFolderBrowseDialog } from "../components/ServerFolderBrowseDialog";
import { readComposerDraft, setComposerDraft } from "../lib/composerDrafts";
import { toggleBoardAutoStart, useBoardAutoStart } from "../lib/boardAutoStart";
import { pickCreateProvider } from "../lib/harness";
import { useT } from "../lib/i18n";
import { folderLabel } from "../lib/pathSegments";
import { useAppStore } from "../lib/store";
import styles from "./BoardPage.module.css";

/** Column order on the board — the same order the spec's four lanes read in. */
const COLUMN_ORDER: BoardColumn[] = ["todo", "progress", "wait", "done"];

/** Where the reader left a board: rail, horizontal lane strip, each lane. */
type BoardScrollState = {
  rail: number;
  /** On phones the rail scrolls inside its own list, on desktop it is the rail. */
  railList: number;
  columnsX: number;
  columns: Partial<Record<BoardColumn, number>>;
};

/**
 * Reading positions kept while a task's chat takes the screen — the board
 * unmounts on the way out, so coming back starts at the top without this.
 * In-memory on purpose: a scroll offset is a reading position, not data.
 */
const boardScrollByBoard: Record<string, BoardScrollState> = {};

const COLUMN_TITLE = {
  todo: "chat.colTodo",
  progress: "chat.colProgress",
  wait: "chat.colWait",
  done: "chat.colDone",
} as const;

type TodoGroup = { cwd: string; label: string; loose: boolean; tasks: SessionDto[] };

/** Where a board folder is named: the project rail, its Todo lane head, the folders dialog. */
type FolderSpot = "rail" | "lane" | "dialog";

/** The folder whose tag is being edited, and the row that took the editor over. */
type FolderTagEdit = { cwd: string; where: FolderSpot };

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
  /** The board's folder tags, keyed by canonical cwd (a board from before they
   *  existed carries none). */
  const folderTags = board?.folderTags ?? {};
  /** Folders whose tasks run one after another, keyed by canonical cwd. */
  const folderAutoRun = board?.folderAutoRun;
  const tasks = useAppStore((s) => s.boardSessions);
  const defaultCwd = useAppStore((s) => s.settings.defaultCwd ?? "");
  const preferredProvider = useAppStore((s) => s.settings.defaultProvider ?? null);
  /** Look of the "Add task" placeholder an empty group offers (settings). */
  const boardAddCardStyle = useAppStore((s) => s.settings.boardAddCardStyle ?? "card");
  /** Whether the new-task form offers its agent picker (on unless switched off). */
  const taskAgentPicker = useAppStore((s) => s.settings.boardTaskAgentPicker !== false);
  const adapters = useAppStore((s) => s.adapters);
  const agentAvailability = useAppStore((s) => s.agentAvailability);
  const refreshBoardSessions = useAppStore((s) => s.refreshBoardSessions);
  const createBoardTask = useAppStore((s) => s.createBoardTask);
  const setTaskDone = useAppStore((s) => s.setTaskDone);
  const setTaskDescription = useAppStore((s) => s.setTaskDescription);
  const setTaskProvider = useAppStore((s) => s.setTaskProvider);
  const deleteBoardTask = useAppStore((s) => s.deleteBoardTask);
  const setBoardFolders = useAppStore((s) => s.setBoardFolders);
  const setBoardFolderTag = useAppStore((s) => s.setBoardFolderTag);
  const setBoardFolderAutoRun = useAppStore((s) => s.setBoardFolderAutoRun);
  const reorderBoardTasks = useAppStore((s) => s.reorderBoardTasks);
  const selectSession = useAppStore((s) => s.selectSession);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  // Shared with the shell header, whose board title row carries the button that
  // opens this page's folders dialog.
  const foldersOpen = useAppStore((s) => s.boardFoldersOpen);
  const setFoldersOpen = useAppStore((s) => s.setBoardFoldersOpen);

  /** Agents for the task picker — the same shape the chat tree's picker takes. */
  const agentOptions = useMemo(
    () =>
      adapters.map((a) => ({ id: a.id, label: a.label, online: agentAvailability[a.id] === true })),
    [adapters, agentAvailability],
  );

  /**
   * The agent a new task goes to unless the form says otherwise: the default
   * agent from settings while it is online, the first online one otherwise —
   * exactly what the new-chat picker preselects.
   */
  const defaultTaskProvider = useMemo(
    () => pickCreateProvider(agentAvailability, adapters.map((a) => a.id), preferredProvider),
    [adapters, agentAvailability, preferredProvider],
  );

  const [newTaskPicker, setNewTaskPicker] = useState<{ x: number; y: number; cwd: string } | null>(
    null,
  );

  const [filterCwd, setFilterCwd] = useState<string | null>(null);
  const [addingCwd, setAddingCwd] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Agent the form's picker shows; empty = the default agent of the settings. */
  const [draftProvider, setDraftProvider] = useState<AgentProvider | "">("");
  const [creating, setCreating] = useState(false);
  /** Creation form: send the description as the first message on create. */
  const createAutoStart = useBoardAutoStart("create");
  const [agentMenu, setAgentMenu] = useState<{ task: SessionDto; x: number; y: number } | null>(
    null,
  );
  /** The task card's own context menu (right-click anywhere on the card). */
  const [taskMenu, setTaskMenu] = useState<{ task: SessionDto; x: number; y: number } | null>(
    null,
  );
  const [taskMenuPos, setTaskMenuPos] = useState<{ x: number; y: number } | null>(null);
  /** A folder's context menu (rail row, board lane head, folders dialog row). */
  const [folderMenu, setFolderMenu] = useState<
    ({ cwd: string; where: FolderSpot } & { x: number; y: number }) | null
  >(null);
  const [folderMenuPos, setFolderMenuPos] = useState<{ x: number; y: number } | null>(null);
  /** The folder whose tag is being edited inline, and where it is edited. */
  const [tagEdit, setTagEdit] = useState<FolderTagEdit | null>(null);
  /** The tag as typed — committed on Enter or on blur, dropped on Escape. */
  const [tagDraft, setTagDraft] = useState("");
  const [exportTaskId, setExportTaskId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [mcpCwd, setMcpCwd] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SessionDto | null>(null);
  /** The Todo card whose text is being rewritten, and the text as typed. */
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  /** The Wait card whose next prompt is being typed on the board, and the text. */
  const [promptTaskId, setPromptTaskId] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** The new-task form as a whole — a press inside it must not dismiss it. */
  const composerBoxRef = useRef<HTMLDivElement>(null);
  /** The card editor as a whole — a press inside it must not dismiss it. */
  const taskEditorRef = useRef<HTMLDivElement>(null);
  /** The quick-prompt form as a whole — a press inside it must not dismiss it. */
  const promptBoxRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railDragRef = useRef<{ startY: number; lastY: number } | null>(null);
  const railListRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef(new Map<BoardColumn, HTMLDivElement>());
  /** Lanes being put back are mid-restore: their scroll events are ours, not
   *  the reader's, and must not overwrite the position we are restoring to. */
  const restoringRef = useRef(false);
  const restoredBoardRef = useRef<string | null>(null);

  /** Tasks arrive over the network; the position waits for this board's list. */
  const [tasksReady, setTasksReady] = useState(false);
  useEffect(() => {
    setTasksReady(false);
    if (!boardId) return;
    void refreshBoardSessions(boardId).finally(() => setTasksReady(true));
  }, [boardId, refreshBoardSessions]);

  const saveScroll = () => {
    if (!boardId || restoringRef.current) return;
    const columns: Partial<Record<BoardColumn, number>> = {};
    for (const column of COLUMN_ORDER) {
      columns[column] = columnRefs.current.get(column)?.scrollTop ?? 0;
    }
    boardScrollByBoard[boardId] = {
      rail: railRef.current?.scrollTop ?? 0,
      railList: railListRef.current?.scrollTop ?? 0,
      columnsX: columnsRef.current?.scrollLeft ?? 0,
      columns,
    };
  };

  /**
   * Coming back from a task: put the reader where they left the board — same
   * rail, same lanes — then make sure the card the trip started at is on
   * screen (`nearest` scrolls only if it drifted out of view). Retry on the
   * next list change while the lanes are still too short to hold the position.
   */
  useLayoutEffect(() => {
    if (!tasksReady || restoredBoardRef.current === boardId) return;
    const saved = boardId ? boardScrollByBoard[boardId] : undefined;
    if (!saved) {
      restoredBoardRef.current = boardId;
      return;
    }
    restoringRef.current = true;
    if (railRef.current) railRef.current.scrollTop = saved.rail;
    if (railListRef.current) railListRef.current.scrollTop = saved.railList;
    if (columnsRef.current) columnsRef.current.scrollLeft = saved.columnsX;
    for (const column of COLUMN_ORDER) {
      const el = columnRefs.current.get(column);
      if (el) el.scrollTop = saved.columns[column] ?? 0;
    }
    for (const column of COLUMN_ORDER) {
      const el = columnRefs.current.get(column);
      const top = saved.columns[column] ?? 0;
      if (!el || top <= 0) continue;
      const maxTop = el.scrollHeight - el.clientHeight;
      if (el.scrollTop < top - 1 && el.scrollTop < maxTop - 1) return;
    }
    restoredBoardRef.current = boardId;
    restoringRef.current = false;
    const origin = useAppStore.getState().activeSessionId;
    if (!origin) return;
    document
      .querySelector<HTMLElement>(`[data-task-id="${origin}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [boardId, tasks, tasksReady]);

  // A board that vanished (deleted elsewhere) must not strand the user here.
  useEffect(() => {
    if (boards.length && !board) navigate("/chat", { replace: true });
  }, [boards, board, navigate]);

  // The open flag is shared with the shell header, so leaving the board has to
  // clear it: a dialog still open at unmount would otherwise pop up by itself
  // on the next visit to the board.
  useEffect(() => () => setFoldersOpen(false), [setFoldersOpen]);

  // The composer only exists while a group has it open.
  useEffect(() => {
    if (!addingCwd) return;
    composerRef.current?.focus();
  }, [addingCwd]);

  // Each form starts on the default agent instead of the last agent picked.
  useEffect(() => {
    setDraftProvider("");
  }, [addingCwd]);

  /**
   * The new-task form belongs to its group, not to the screen: a press anywhere
   * else dismisses it exactly like its own Cancel button, so an accidental "+"
   * (or a change of mind) does not leave a form sitting in the lane. The lane's
   * placeholder opens the same form again with one click.
   */
  useEffect(() => {
    if (!addingCwd) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (composerBoxRef.current?.contains(target)) return;
      // A dialog (or a picker's list) the board opened on top owns the press:
      // choosing there closes the form through its own handler.
      if (target instanceof Element && target.closest('[role="dialog"], [role="listbox"]')) return;
      setAddingCwd(null);
      setDraft("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addingCwd]);

  /**
   * The card editor and the quick-prompt form belong to their card, exactly
   * like the new-task form belongs to its group: a press anywhere else closes
   * them the way their own Cancel button does, so a half-typed rewrite — or a
   * prompt that was never sent — is not left sitting in the lane. A dialog the
   * board opened on top keeps the press.
   */
  useEffect(() => {
    if (!editTaskId && !promptTaskId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (taskEditorRef.current?.contains(target)) return;
      if (promptBoxRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      cancelTaskEdit();
      cancelPromptEntry();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editTaskId, promptTaskId]);

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

  useEffect(() => {
    if (!taskMenu) return;
    const onDown = (e: MouseEvent) => {
      if (taskMenuRef.current?.contains(e.target as Node)) return;
      setTaskMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTaskMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [taskMenu]);

  useEffect(() => {
    if (!folderMenu) return;
    const onDown = (e: MouseEvent) => {
      if (folderMenuRef.current?.contains(e.target as Node)) return;
      setFolderMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFolderMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [folderMenu]);

  const columns = useMemo(() => {
    const byColumn: Record<BoardColumn, SessionDto[]> = {
      todo: [],
      progress: [],
      wait: [],
      done: [],
    };
    for (const task of tasks) byColumn[boardColumn(task)].push(task);
    for (const column of COLUMN_ORDER) {
      // Done is a log, not a list to arrange: most recently finished on top.
      // The manual order stays where it means something — Todo.
      byColumn[column].sort(
        column === "done"
          ? (a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "")
          : (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
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
   * Open a task in the normal chat. A task that never started seeds its
   * description into the composer draft (never sent): the first turn starts
   * when the user presses Enter, exactly like any other chat. A started task
   * opens clean — its description was already sent as the first message, and
   * re-seeding would copy it into the input on every reopen.
   */
  const openTask = async (task: SessionDto, provider?: AgentProvider) => {
    const description = task.taskDescription?.trim();
    if (!task.startedAt && description && !readComposerDraft(task.id)) {
      setComposerDraft(task.id, description);
    }
    // The click answers before the network: navigate runs with no await
    // ahead of it, and on the common path selectSession's synchronous prefix
    // (active id + loading skeleton) lands in the same React batch — the
    // detail GET streams in behind the chat instead of gating it. The
    // agent-menu PATCH keeps its place ahead of that GET: a detail fetched
    // first would adopt the provider the user just replaced.
    navigate("/chat");
    if (provider && provider !== task.provider) await setTaskProvider(task.id, provider);
    await selectSession(task.id);
  };

  /**
   * Start a task from the board: send the description as the first message
   * and stay put. The claimed turn stamps startedAt server-side, so the card
   * leaves Todo over the session mirror — no navigation, no draft.
   */
  const startTask = async (task: SessionDto, provider?: AgentProvider) => {
    if (provider && provider !== task.provider) await setTaskProvider(task.id, provider);
    const text = task.taskDescription?.trim() || task.title;
    if (text) await sendPrompt(text, { sessionId: task.id });
  };

  /** Tasks a folder queue has already handed to their agent on this visit. */
  const queuedRef = useRef(new Set<string>());

  /**
   * Folder queue: with "run one after another" switched on for a folder, its
   * Todo cards start by themselves, top to bottom — one at a time, each next
   * one leaving as soon as the folder's running task stops. A card handed over
   * once is never handed over again, so a refresh of the list cannot start the
   * same task twice.
   */
  useEffect(() => {
    if (!tasksReady || !board) return;
    for (const cwd of board.folders) {
      if (!folderAutoRun?.[cwd]) continue;
      // One at a time: the folder waits for the task still running in it.
      if (tasks.some((task) => task.cwd === cwd && task.status === "running")) continue;
      const next = groups.find((group) => group.cwd === cwd)?.tasks[0];
      if (!next || queuedRef.current.has(next.id)) continue;
      // A card with no text has nothing to send — it waits for the user.
      if (!(next.taskDescription?.trim() || next.title)) continue;
      queuedRef.current.add(next.id);
      void startTask(next).catch(() => queuedRef.current.delete(next.id));
    }
  }, [board, folderAutoRun, groups, startTask, tasks, tasksReady]);

  const submitNewTask = async (cwd: string) => {
    const description = draft.trim();
    if (!description || creating) return;
    // The form's own pick, or the default agent it opened on; a form without
    // the picker leaves the choice to the server (settings default).
    const provider = taskAgentPicker ? draftProvider || defaultTaskProvider : null;
    setCreating(true);
    const created = await createBoardTask({
      boardId,
      cwd,
      description,
      ...(provider ? { provider } : {}),
    });
    setCreating(false);
    if (!created) return; // keep the form so nothing the user typed is lost
    setDraft("");
    setAddingCwd(null);
    if (createAutoStart) void startTask(created);
  };

  /**
   * Right-click on a folder's **+**: rather than the inline description form,
   * open the standard new-chat picker with the folder locked, then create the
   * task empty for the agent it confirms — the shape a chat has when it comes
   * from the folder tree, where nothing is described up front and the first
   * message is what names and forms the task. The card rests in **Todo** until
   * that first turn runs.
   */
  const openTaskPicker = (e: React.MouseEvent, cwd: string) => {
    e.preventDefault();
    setNewTaskPicker({ x: e.clientX, y: e.clientY, cwd });
  };

  const createEmptyTask = async (cwd: string, provider: AgentProvider) => {
    if (creating) return;
    setCreating(true);
    const created = await createBoardTask({ boardId, cwd, description: "", provider });
    setCreating(false);
    if (!created) return;
    await openTask(created);
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

  /**
   * Right-click on the card's play icon: run the task with an agent other than
   * the one it was created for. The new-task form has an agent picker of its
   * own (settings), and with it on the agent was already picked when the task
   * was created — then the arrow has no second choice to offer, and the press
   * falls through to the card's menu like it does on the card's other icons.
   */
  const openAgentMenu = (e: React.MouseEvent, task: SessionDto) => {
    if (taskAgentPicker) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAgentMenu({
      task,
      x: Math.max(12, Math.min(rect.left, window.innerWidth - 240)),
      y: Math.min(rect.bottom + 6, window.innerHeight - 300),
    });
  };

  /** Open the card menu where the press landed; place it after measuring. */
  const openTaskMenu = (e: React.MouseEvent, task: SessionDto) => {
    e.preventDefault();
    e.stopPropagation();
    setTaskMenu({ task, x: e.clientX, y: e.clientY });
  };

  /**
   * Rewrite a task card where it lies: the editor takes the card over, seeded
   * with the text the card shows — a task created empty has none, and its
   * title is that text.
   */
  const startTaskEdit = (task: SessionDto) => {
    setTaskMenu(null);
    setEditDraft(task.taskDescription?.trim() || task.title);
    setEditTaskId(task.id);
  };

  const cancelTaskEdit = () => {
    setEditTaskId(null);
    setEditDraft("");
  };

  /** Commit the card editor; an empty text is never saved — a card without one is nothing to read. */
  const submitTaskEdit = async (task: SessionDto) => {
    const description = editDraft.trim();
    if (!description || savingEdit) return;
    setSavingEdit(true);
    await setTaskDescription(task.id, description);
    setSavingEdit(false);
    cancelTaskEdit();
  };

  /**
   * Quick prompt: the next message to a task that is waiting is typed on its
   * own card and sent from there — a task that stopped with a question, or
   * simply finished its turn, is answered without leaving the board for its
   * chat. The send goes through the same door the chat's composer uses, so a
   * task whose agent is still busy has the text queued instead of lost.
   */
  const startPromptEntry = (task: SessionDto) => {
    setTaskMenu(null);
    setPromptDraft("");
    setPromptTaskId(task.id);
  };

  const cancelPromptEntry = () => {
    setPromptTaskId(null);
    setPromptDraft("");
  };

  /** Send the typed prompt; a send that fails keeps the form and its text. */
  const submitPrompt = async (task: SessionDto) => {
    const text = promptDraft.trim();
    if (!text || sendingPrompt) return;
    setSendingPrompt(true);
    try {
      await sendPrompt(text, { sessionId: task.id });
    } finally {
      setSendingPrompt(false);
    }
    cancelPromptEntry();
  };

  /** Measure → clamp into the viewport, before paint (no wrong-spot flash). */
  useLayoutEffect(() => {
    const el = taskMenuRef.current;
    if (!taskMenu || !el) {
      setTaskMenuPos(null);
      return;
    }
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const x = Math.min(
      Math.max(12, taskMenu.x),
      Math.max(12, window.innerWidth - width - 12),
    );
    const y = Math.min(
      Math.max(12, taskMenu.y),
      Math.max(12, window.innerHeight - height - 12),
    );
    setTaskMenuPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  });

  /** Open a folder's context menu where the press landed; placed after measuring. */
  const openFolderMenu = (e: React.MouseEvent, cwd: string, where: FolderSpot) => {
    e.preventDefault();
    e.stopPropagation();
    setFolderMenu({ cwd, where, x: e.clientX, y: e.clientY });
  };

  /** Measure → clamp into the viewport, before paint (no wrong-spot flash). */
  useLayoutEffect(() => {
    const el = folderMenuRef.current;
    if (!folderMenu || !el) {
      setFolderMenuPos(null);
      return;
    }
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const x = Math.min(
      Math.max(12, folderMenu.x),
      Math.max(12, window.innerWidth - width - 12),
    );
    const y = Math.min(
      Math.max(12, folderMenu.y),
      Math.max(12, window.innerHeight - height - 12),
    );
    setFolderMenuPos((prev) => (prev && prev.x === x && prev.y === y ? prev : { x, y }));
  });

  /** The folder menu's first command: start the inline new-task form on the folder. */
  const addTaskToFolder = (cwd: string) => {
    setFolderMenu(null);
    setFoldersOpen(false);
    setRailOpen(false);
    setFilterCwd(cwd);
    setAddingCwd(cwd);
    setDraft("");
  };

  /**
   * Start editing a folder's tag on the row the menu was opened from — the
   * rail row, its Todo lane head or the folders dialog row. The editor stays
   * where it was invoked, so the row the user pointed at is the one that goes
   * editable; a rail row keeps the rail as it is (its mobile sheet stays open
   * under the editor) rather than moving it to a lane that may be off screen.
   */
  const startFolderTagEdit = (cwd: string, where: FolderSpot) => {
    setFolderMenu(null);
    setTagDraft(folderTags[cwd] ?? "");
    setTagEdit({ cwd, where });
  };

  /** Commit the inline folder-tag editor; an empty value clears the tag. */
  const commitFolderTag = () => {
    const edit = tagEdit;
    setTagEdit(null);
    if (!edit || tagDraft.trim() === (folderTags[edit.cwd] ?? "")) return;
    void setBoardFolderTag(boardId, edit.cwd, tagDraft);
  };

  /**
   * A folder's tag where the folder is named: the quiet chip, or the inline
   * editor when this very row is the one the tag is being edited in (Enter
   * saves, Escape cancels, an empty value clears it).
   */
  const renderFolderTag = (cwd: string, where?: FolderSpot) => {
    if (where && tagEdit?.cwd === cwd && tagEdit.where === where) {
      return (
        <input
          className={styles.folderTagEdit}
          value={tagDraft}
          maxLength={80}
          placeholder={t("chat.folderTagPlaceholder")}
          aria-label={t("chat.folderTagTitle")}
          title={t("chat.folderTagTitle")}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitFolderTag();
            else if (e.key === "Escape") setTagEdit(null);
          }}
          onBlur={() => {
            if (tagEdit?.cwd === cwd && tagEdit.where === where) commitFolderTag();
          }}
        />
      );
    }
    const tag = folderTags[cwd];
    return tag ? (
      <span className={styles.folderTag} title={tag}>
        {tag}
      </span>
    ) : null;
  };

  /**
   * Marker on a folder whose tasks run one after another: the switch itself
   * lives in the folder menu, this says at a glance that the queue is armed.
   */
  const renderQueueBadge = (cwd: string) =>
    folderAutoRun?.[cwd] ? (
      <span className={styles.queueBadge} title={t("chat.boardFolderQueue")} aria-hidden>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 7h11M4 12h11M4 17h7"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path d="M17 11v7l6-3.5-6-3.5Z" fill="currentColor" />
        </svg>
      </span>
    ) : null;

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
        onContextMenu={(e) => openTaskMenu(e, task)}
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
                  className={styles.iconBtn}
                  title={t("chat.boardEditTask")}
                  aria-label={t("chat.boardEditTask")}
                  onClick={(e) => {
                    e.stopPropagation();
                    startTaskEdit(task);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M4.5 19.5h15M6 15.5l9.6-9.6a1.7 1.7 0 0 1 2.4 2.4L8.4 18H6v-2.5Z"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.iconStart}`}
                  title={t("chat.boardStart")}
                  aria-label={t("chat.boardStart")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void startTask(task);
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
        {column === "todo" && editTaskId === task.id ? (
          /* The editor takes the card over where the card lies: the text being
             rewritten stays on the lane and in the project group it belongs to. */
          <div
            ref={taskEditorRef}
            className={styles.cardEdit}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <textarea
              className={styles.composerInput}
              value={editDraft}
              maxLength={20000}
              placeholder={t("chat.boardTaskPlaceholder")}
              aria-label={t("chat.boardEditTask")}
              autoFocus
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitTaskEdit(task);
                } else if (e.key === "Escape") {
                  cancelTaskEdit();
                }
              }}
            />
            <div className={styles.composerActions}>
              <button type="button" className={styles.ghostBtn} onClick={cancelTaskEdit}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!editDraft.trim() || savingEdit}
                onClick={() => void submitTaskEdit(task)}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.cardText}>{text}</p>
        )}
        {column === "wait" && promptTaskId === task.id ? (
          /* The next prompt is typed on the card itself: the task's own text
             stays readable above it, and nothing leaves the board. */
          <div
            ref={promptBoxRef}
            className={styles.cardEdit}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <textarea
              className={styles.composerInput}
              value={promptDraft}
              maxLength={20000}
              placeholder={t("chat.boardNextPromptPlaceholder")}
              aria-label={t("chat.boardNextPrompt")}
              autoFocus
              onChange={(e) => setPromptDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitPrompt(task);
                } else if (e.key === "Escape") {
                  cancelPromptEntry();
                }
              }}
            />
            <div className={styles.composerActions}>
              <button type="button" className={styles.ghostBtn} onClick={cancelPromptEntry}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={!promptDraft.trim() || sendingPrompt}
                onClick={() => void submitPrompt(task)}
              >
                {t("common.send")}
              </button>
            </div>
          </div>
        ) : null}
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
      {/* The board's title row lives in the shell header, above the page: one
          top bar for the whole view instead of a second header under it. */}

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
          onScroll={saveScroll}
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
          <div ref={railListRef} className={styles.railList} onScroll={saveScroll}>
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
            {groups.map((group) => {
              /** This row took the tag editor over, and it opens right here. */
              const editingTag = tagEdit?.cwd === group.cwd && tagEdit.where === "rail";
              const row = (
                <>
                  <span className={styles.railLabel}>{group.label}</span>
                  {renderFolderTag(group.cwd, editingTag ? "rail" : undefined)}
                  {renderQueueBadge(group.cwd)}
                  <span className={styles.railCount}>
                    {tasks.filter((task) => task.cwd === group.cwd).length}
                  </span>
                </>
              );
              return (
                <div
                  key={group.cwd}
                  data-rail-cwd={group.cwd}
                  className={`${styles.railRow} ${
                    filterCwd === group.cwd ? styles.railRowOn : ""
                  }`}
                >
                  {/* A tag editor is a text field, and a field cannot live
                      inside a button: the edited row is a plain container for
                      as long as it holds the editor, its neighbours stay
                      buttons. */}
                  {editingTag ? (
                    <div
                      className={`${styles.railItem} ${styles.railItemEditing}`}
                      title={group.cwd}
                    >
                      {row}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.railItem}
                      title={group.cwd}
                      onClick={() => {
                        setFilterCwd(filterCwd === group.cwd ? null : group.cwd);
                        setRailOpen(false);
                      }}
                      onContextMenu={(e) => openFolderMenu(e, group.cwd, "rail")}
                    >
                      {row}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.railAdd}
                    title={t("chat.boardAddTaskHint")}
                    aria-label={t("chat.boardAddTask")}
                    onClick={() => {
                      setFilterCwd(group.cwd);
                      setAddingCwd(group.cwd);
                      setRailOpen(false);
                    }}
                    onContextMenu={(e) => openTaskPicker(e, group.cwd)}
                  >
                    +
                  </button>
                </div>
              );
            })}
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

        <div ref={columnsRef} className={styles.columns} onScroll={saveScroll}>
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
                <div
                  ref={(el) => {
                    if (el) columnRefs.current.set(column, el);
                    else columnRefs.current.delete(column);
                  }}
                  className={styles.columnBody}
                  onScroll={saveScroll}
                >
                  {column === "todo"
                    ? visibleGroups.map((group, groupIndex) => (
                        <div key={group.cwd} className={styles.group} data-group={group.cwd}>
                          <div
                            className={styles.groupHead}
                            onContextMenu={(e) => openFolderMenu(e, group.cwd, "lane")}
                          >
                            <span className={styles.groupName} title={group.cwd}>
                              {group.label}
                            </span>
                            {renderFolderTag(group.cwd, "lane")}
                            {renderQueueBadge(group.cwd)}
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
                                title={t("chat.boardAddTaskHint")}
                                aria-label={t("chat.boardAddTask")}
                                onClick={() => {
                                  setAddingCwd(group.cwd);
                                  setDraft("");
                                }}
                                onContextMenu={(e) => openTaskPicker(e, group.cwd)}
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
                            <div ref={composerBoxRef} className={styles.composer}>
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
                              {/* The agent the task is created for: the default
                                  one unless the user picks another here. */}
                              {taskAgentPicker && agentOptions.length ? (
                                <div className={styles.composerField}>
                                  <span className={styles.composerFieldLabel}>
                                    {t("chat.boardTaskAgent")}
                                  </span>
                                  <OptionPicker
                                    variant="compact"
                                    placement="up"
                                    menuTitle={t("chat.boardTaskAgent")}
                                    placeholder={t("common.pickAgent")}
                                    value={draftProvider || defaultTaskProvider || ""}
                                    options={agentOptions.map((agent) => ({
                                      value: agent.id,
                                      label: agent.label,
                                    }))}
                                    onChange={(value) =>
                                      setDraftProvider(value as AgentProvider)
                                    }
                                  />
                                </div>
                              ) : null}
                              <div className={styles.composerActions}>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={createAutoStart}
                                  className={`${styles.autoStart}${
                                    createAutoStart ? ` ${styles.switchOn}` : ""
                                  }`}
                                  title={t("chat.boardAutoStart")}
                                  onClick={() => toggleBoardAutoStart("create")}
                                >
                                  {t("chat.boardAutoStart")}
                                  <span className={styles.switchTrack} aria-hidden>
                                    <span className={styles.switchKnob} />
                                  </span>
                                </button>
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
                          ) : boardAddCardStyle !== "hidden" ? (
                            <button
                              type="button"
                              className={
                                boardAddCardStyle === "compact"
                                  ? `${styles.addCard} ${styles.addCardCompact}`
                                  : styles.addCard
                              }
                              title={t("chat.boardAddTaskCard")}
                              onClick={() => {
                                setAddingCwd(group.cwd);
                                setDraft("");
                              }}
                            >
                              {t("chat.boardAddTaskCard")}
                            </button>
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
            {/* The arrow that opened this menu is the start button itself, so
                the agent picked here is a start, not a question to re-ask. */}
            {adapters.map((adapter) => (
              <button
                key={adapter.id}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  const task = agentMenu.task;
                  setAgentMenu(null);
                  void startTask(task, adapter.id);
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

      {taskMenu &&
        createPortal(
          <div
            ref={taskMenuRef}
            className={styles.menu}
            style={{
              left: taskMenuPos?.x ?? taskMenu.x,
              top: taskMenuPos?.y ?? taskMenu.y,
              visibility: taskMenuPos ? "visible" : "hidden",
            }}
            role="menu"
          >
            {/* A task that has not started is still only a description, so it
                stays rewritable; once it runs, the text is what was sent. */}
            {boardColumn(taskMenu.task) === "todo" ? (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => startTaskEdit(taskMenu.task)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4.5 19.5h15M6 15.5l9.6-9.6a1.7 1.7 0 0 1 2.4 2.4L8.4 18H6v-2.5Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("chat.boardEditTask")}
              </button>
            ) : null}
            {/* A Wait card is a task whose agent stopped — its turn finished,
                or it is asking something — so what is most likely wanted from
                the board is the next prompt, typed right here. */}
            {boardColumn(taskMenu.task) === "wait" ? (
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => startPromptEntry(taskMenu.task)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M12 19V5M12 5l-6 6M12 5l6 6"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t("chat.boardNextPrompt")}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                const task = taskMenu.task;
                setTaskMenu(null);
                setExportTaskId(task.id);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {t("chat.exportChat")}
            </button>
          </div>,
          document.body,
        )}

      {folderMenu &&
        createPortal(
          <div
            ref={folderMenuRef}
            className={styles.menu}
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
              className={styles.menuItem}
              onClick={() => addTaskToFolder(folderMenu.cwd)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              {t("chat.boardAddTask")}
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => startFolderTagEdit(folderMenu.cwd, folderMenu.where)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4.5 7.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path
                  d="M7.5 11h9M7.5 14.5h5.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              {t("chat.folderTagMenu")}
            </button>
            {/* The folder's own setting: its tasks run one after another. */}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={folderAutoRun?.[folderMenu.cwd] === true}
              className={`${styles.menuItem} ${
                folderAutoRun?.[folderMenu.cwd] ? `${styles.menuToggleOn} ${styles.switchOn}` : ""
              }`}
              onClick={() => {
                const cwd = folderMenu.cwd;
                const next = !folderAutoRun?.[cwd];
                setFolderMenu(null);
                void setBoardFolderAutoRun(boardId, cwd, next);
              }}
            >
              {t("chat.boardFolderQueue")}
              <span className={`${styles.switchTrack} ${styles.switchTrackEnd}`} aria-hidden>
                <span className={styles.switchKnob} />
              </span>
            </button>
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
                    <div
                      key={cwd}
                      className={styles.folderRow}
                      onContextMenu={(e) => openFolderMenu(e, cwd, "dialog")}
                    >
                      <span className={styles.folderPath} title={cwd}>
                        {cwd}
                      </span>
                      {renderFolderTag(cwd, "dialog")}
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

      {newTaskPicker && (
        <CreateSessionFolderPicker
          x={newTaskPicker.x}
          y={newTaskPicker.y}
          lockedCwd={newTaskPicker.cwd}
          agentOnly
          recentCwds={[]}
          agents={agentOptions}
          preferredProvider={preferredProvider}
          onClose={() => setNewTaskPicker(null)}
          onConfirm={async (cwd, provider) => {
            setNewTaskPicker(null);
            await createEmptyTask(cwd, provider as AgentProvider);
          }}
        />
      )}

      {exportTaskId &&
        createPortal(
          <ExportDialog open sessionId={exportTaskId} onClose={() => setExportTaskId(null)} />,
          document.body,
        )}
    </div>
  );
}
