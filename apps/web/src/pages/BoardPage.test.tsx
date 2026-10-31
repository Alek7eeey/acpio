// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import {
  DEFAULT_SETTINGS,
  defaultBoardColumns,
  type BoardColumnDto,
  type BoardDto,
  type SessionDto,
} from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { composerDraftSnapshot, forgetComposerDraft } from "../lib/composerDrafts";
import { I18nProvider } from "../lib/i18n";
import { BoardPage } from "./BoardPage";
import styles from "./BoardPage.module.css";
import pickerStyles from "../components/ModelPicker.module.css";

const apiMock = vi.hoisted(() => {
  /** A promise that never settles — the pending network round-trip. */
  const pending = <T,>(): Promise<T> => Promise.withResolvers<T>().promise;
  return {
    // The session-detail GET is the slow call this test guards: it stays
    // pending forever, so any handler that awaits it before navigating never
    // reaches the chat route and the assertion below fails.
    getSession: vi.fn(() => pending<unknown>()),
    // The board's task refresh must not replace the seeded card mid-test.
    listBoardSessions: vi.fn(() => pending<unknown>()),
    // A drop inside a Todo group writes the group's order through this call.
    reorderSessions: vi.fn(async (items: Array<{ id: string; sortOrder: number }>) => items),
    // A drop onto another lane writes the card's placement through this one.
    updateSession: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      ...task,
      ...patch,
      id,
    })),
    // Right-click + creates the task with no description before opening it.
    createSession: vi.fn(async (input: Record<string, unknown>) => ({
      ...task,
      id: "t2",
      title: "New chat",
      taskDescription: null,
      ...input,
    })),
    // openTask seeds a composer draft, whose debounced persist calls this
    // after the test's act window — it must not reject unhandled. The body
    // runs at call time, after module init, so the static import is live.
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...DEFAULT_SETTINGS,
      ...patch,
    })),
    // The export dialog probes the server export dir when it opens.
    getExportDefaultDir: vi.fn(async () => ({ path: "/srv/exports" })),
    // The new-task form's model picker asks the agent what it can run.
    listModels: vi.fn(async () => ({ ok: true, models: [], modelParams: [] })),
    getModelParams: vi.fn(async () => ({ ok: true, modelParams: [] })),
    // The derived chat's source transcript, exported before the task is made.
    exportChatReference: vi.fn(async () => ({
      ok: true,
      path: "/srv/exports/ref.md",
      fileName: "ref.md",
      size: 42,
    })),
  };
});
vi.mock("../lib/api", () => ({ api: apiMock }));

// jsdom ships no matchMedia; the new-task picker reads a max-width query to
// decide between the popover and the mobile sheet.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}

const board: BoardDto = {
  id: "b1",
  name: "Delivery",
  folders: ["/projects/app"],
  folderTags: {},
  folderAutoRun: {},
  // A board always carries its four stage homes; the custom ones a test adds
  // are appended to this list.
  columns: defaultBoardColumns(),
  sortOrder: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
};

const task: SessionDto = {
  id: "t1",
  title: "Login bug",
  provider: "omp",
  cwd: "/projects/app",
  mode: "agent",
  status: "idle",
  acpSessionId: null,
  themeId: null,
  sortOrder: 0,
  pinned: false,
  archived: false,
  boardId: "b1",
  taskDescription: "Fix the login bug",
  startedAt: null,
  doneAt: null,
  boardColumnId: null,
  mcpDisabledIds: [],
  createdAt: "2026-09-20T10:05:00.000Z",
  updatedAt: "2026-09-20T10:05:00.000Z",
  lastMessageAt: "2026-09-20T10:05:00.000Z",
};

beforeEach(() => {
  // Typed text outlives the page on purpose (the board comes back with its
  // half-written task); each test starts with an empty draft registry.
  for (const key of Object.keys(composerDraftSnapshot())) forgetComposerDraft(key);
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    boards: [board],
    boardSessions: [task],
    sessions: [],
    activeSessionId: null,
    activeSession: null,
    sessionLoading: false,
    // A rail narrowing outlives the page on purpose; each test starts wide.
    boardFilterCwd: {},
    boardFavoritesOnly: {},
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // jsdom ships no scrollIntoView; the reading-position test installs a spy.
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("BoardPage card headline", () => {
  // The model-refined title lives in task.title, while the card body is the
  // task description — without a headline the refinement was invisible here.
  it("shows a refined title above the description", async () => {
    useAppStore.setState({
      boardSessions: [{ ...task, title: "Validate the login form" }],
    });
    renderBoard();

    const card = (await screen.findByText("Fix the login bug")).closest(
      "[data-task-id]",
    ) as HTMLElement;
    expect(within(card).getByText("Validate the login form")).toBeTruthy();
  });

  // Before refinement the title *is* the description's first line — showing
  // it too would print the same words twice on one card.
  it("omits the headline while the title still duplicates the description", async () => {
    useAppStore.setState({
      boardSessions: [{ ...task, title: "Fix the login bug" }],
    });
    renderBoard();

    await screen.findByText("Fix the login bug");
    expect(screen.queryByText("Fix the login bug")).toBeTruthy();
    // One element carries the text — the body, not a headline above it.
    expect(screen.getAllByText("Fix the login bug")).toHaveLength(1);
  });

  // A task without a description falls back to the title as its body text.
  it("uses the title as the body when there is no description", async () => {
    useAppStore.setState({
      boardSessions: [{ ...task, title: "Empty-task title", taskDescription: "" }],
    });
    renderBoard();

    const body = await screen.findByText("Empty-task title");
    expect(body.closest("[data-task-id]")).toBeTruthy();
    // The body is the description-classed paragraph, not a headline.
    expect(body.className).toContain("cardText");
  });
});

describe("BoardPage Todo drag and drop", () => {
  const second: SessionDto = {
    ...task,
    id: "t2",
    title: "Second task",
    taskDescription: "Second task",
    sortOrder: 1,
    createdAt: "2026-09-20T10:06:00.000Z",
    updatedAt: "2026-09-20T10:06:00.000Z",
    lastMessageAt: "2026-09-20T10:06:00.000Z",
  };

  /** A drag as the browser reports it: press, move past the threshold, release
   *  over the card the point test answers with. */
  function dragCard(from: HTMLElement, over: HTMLElement) {
    // jsdom ships no point hit-testing; the card under the pointer is the one
    // the drag resolves against.
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: () => [over],
    });
    try {
      fireEvent.pointerDown(from, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientY: 80 });
      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientY: 80 });
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }
  }

  /** A touch that holds the card still first then moves is a drag, and the
   *  board must not pan under it — while a swipe that travels sooner is the
   *  scroll's and stays untouched (that was the broken half). */
  it("lets a touch swipe scroll the board and takes the card on a hold", async () => {
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");
    const card = container.querySelector('[data-task-id="t1"]') as HTMLElement;

    vi.useFakeTimers();
    try {
      // A swipe travels before the hold: the drag gives up, nothing is blocked.
      fireEvent.pointerDown(card, { pointerId: 1, pointerType: "touch", clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, pointerType: "touch", clientX: 60, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.body.querySelector("[data-drag-preview]")).toBeNull();
      const swipe = new Event("touchmove", { cancelable: true, bubbles: true });
      window.dispatchEvent(swipe);
      expect(swipe.defaultPrevented).toBe(false);
      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch", clientY: 10 });

      // A held finger takes the card, and from then on the pan is refused.
      fireEvent.pointerDown(card, { pointerId: 2, pointerType: "touch", clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(document.body.querySelector("[data-drag-preview]")).toBeTruthy();
      const pan = new Event("touchmove", { cancelable: true, bubbles: true });
      window.dispatchEvent(pan);
      expect(pan.defaultPrevented).toBe(true);

      // The end of the drag hands the gesture back.
      fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientY: 10 });
      const later = new Event("touchmove", { cancelable: true, bubbles: true });
      window.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The arrows move a card one slot at a time; the drag is the same move made
  // where the card is — the release writes the group's order the arrows write.
  it("moves a card below the one it was dropped on", async () => {
    useAppStore.setState({ boardSessions: [task, second] });
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    const cardOf = (id: string) =>
      container.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
    dragCard(cardOf("t1"), cardOf("t2"));

    await waitFor(() => expect(apiMock.reorderSessions).toHaveBeenCalledTimes(1));
    expect(apiMock.reorderSessions.mock.calls[0][0]).toEqual([
      { id: "t2", themeId: null, sortOrder: 0 },
      { id: "t1", themeId: null, sortOrder: 1 },
    ]);
    // The lane shows the drop at once, before the server answers.
    const order = Array.from(
      container.querySelectorAll('[data-column="todo"] [data-task-id]'),
    ).map((el) => el.getAttribute("data-task-id"));
    expect(order).toEqual(["t2", "t1"]);

    // The pointerup that ends a drag is not a press on the card either.
    fireEvent.click(cardOf("t1"));
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  // The swallow covers the one click its own pointerup produces: the next press
  // on a card — a lane's card included — opens that card as usual.
  it("opens a card of another lane on the press that follows a drag", async () => {
    const waiting: SessionDto = {
      ...second,
      id: "t3",
      title: "Waiting task",
      taskDescription: "Waiting task",
      startedAt: "2026-09-20T11:00:00.000Z",
      doneAt: null,
      sortOrder: 0,
    };
    useAppStore.setState({ boardSessions: [task, second, waiting] });
    const { container } = renderBoard();
    await screen.findByText("Waiting task");

    const cardOf = (id: string) =>
      container.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
    dragCard(cardOf("t1"), cardOf("t2"));
    await waitFor(() => expect(apiMock.reorderSessions).toHaveBeenCalledTimes(1));

    await userEvent.click(cardOf("t3"));

    expect(useAppStore.getState().activeSessionId).toBe("t3");
  });

  // The project group is the list being reordered: a card of another folder is
  // no slot for this one, and the drop leaves the order alone.
  it("ignores a drop over a card of another project", async () => {
    const foreign: SessionDto = {
      ...second,
      id: "t9",
      cwd: "/projects/api",
      title: "Other project task",
      taskDescription: "Other project task",
      sortOrder: 0,
    };
    useAppStore.setState({
      boards: [{ ...board, folders: ["/projects/app", "/projects/api"] }],
      boardSessions: [task, second, foreign],
    });
    const { container } = renderBoard();
    await screen.findByText("Other project task");

    const cardOf = (id: string) =>
      container.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
    dragCard(cardOf("t1"), cardOf("t9"));

    expect(apiMock.reorderSessions).not.toHaveBeenCalled();
    expect(
      useAppStore.getState().boardSessions.map((item) => [item.id, item.sortOrder]),
    ).toEqual([
      ["t1", 0],
      ["t2", 1],
      ["t9", 0],
    ]);
  });
});

describe("BoardPage custom columns", () => {
  /** A lane of the reader's own, outside the lifecycle. */
  const review: BoardColumnDto = {
    id: "col-review",
    title: "Review",
    kind: "manual",
    anchor: null,
    home: false,
    sortOrder: 4,
    sortMode: "manual",
    acceptsPrompt: true,
    keepOnRun: false,
  };

  const finishedTask: SessionDto = {
    ...task,
    id: "t2",
    title: "Finished task",
    taskDescription: "Finished task",
    startedAt: "2026-09-20T10:06:00.000Z",
  };

  it("renders a lane the reader added and keeps the card standing in it", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [{ ...finishedTask, boardColumnId: "col-review" }],
    });
    const { container } = renderBoard();
    await screen.findByText("Finished task");

    const lane = container.querySelector('[data-column="col-review"]') as HTMLElement;
    expect(lane).toBeTruthy();
    expect(within(lane).getByText("Review")).toBeTruthy();
    expect(lane.querySelector('[data-task-id="t2"]')).toBeTruthy();
    // The lifecycle would have put it in Wait: the placement wins.
    expect(container.querySelector('[data-column="wait"] [data-task-id="t2"]')).toBeNull();
  });

  // A lane is a place, never a condition: it holds what was dropped in it and
  // claims nothing, so Wait keeps every card the lifecycle puts there.
  it("leaves a finished turn in Wait while no hand puts it elsewhere", async () => {
    const question: SessionDto = {
      ...finishedTask,
      id: "t3",
      title: "Question task",
      taskDescription: "Question task",
      status: "waiting",
    };
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [finishedTask, question],
    });
    const { container } = renderBoard();
    await screen.findByText("Finished task");
    await screen.findByText("Question task");

    const waitLane = container.querySelector('[data-column="wait"]') as HTMLElement;
    expect(waitLane.querySelector('[data-task-id="t2"]')).toBeTruthy();
    expect(waitLane.querySelector('[data-task-id="t3"]')).toBeTruthy();
    expect(
      (container.querySelector('[data-column="col-review"]') as HTMLElement).querySelector(
        '[data-task-id="t2"]',
      ),
    ).toBeNull();
  });

  it("places a card in another lane when it is dragged there", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [task],
    });
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    const card = container.querySelector('[data-task-id="t1"]') as HTMLElement;
    const lane = container.querySelector('[data-column="col-review"]') as HTMLElement;
    // jsdom ships no point hit-testing: the lane under the pointer is the one
    // the drag resolves against.
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: () => [lane],
    });
    try {
      fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientY: 20 });

      // The card the hand carries is on screen under the pointer, and the card
      // itself is dimmed where it lay.
      const preview = document.body.querySelector("[data-drag-preview]") as HTMLElement | null;
      expect(preview?.textContent).toContain("Fix the login bug");
      expect(card.className).toContain("cardDragging");

      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientY: 20 });
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }

    // Released: the copy is gone, and the drop was written.
    expect(document.body.querySelector("[data-drag-preview]")).toBeNull();
    await waitFor(() => expect(apiMock.updateSession).toHaveBeenCalledTimes(1));
    expect(apiMock.updateSession.mock.calls[0][1]).toEqual({ boardColumnId: "col-review" });
  });

  // A drag is a gesture, not a selection: the pointer travels over the card's
  // own words, and the press has already anchored a selection there by the time
  // the threshold is crossed — a whole card painted blue on the way to the next
  // lane. The drag owns the gesture, so the page stops selecting while it lasts
  // and picks the habit up again on release.
  it("selects no text while a card is being dragged", async () => {
    useAppStore.setState({ boardSessions: [task] });
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    const card = container.querySelector('[data-task-id="t1"]') as HTMLElement;
    // The point stays on the card being read: this gesture is about the text
    // under the pointer, not about where it would land.
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: () => [card],
    });
    // The selection the press on the card's text already started.
    const range = document.createRange();
    range.selectNodeContents(card);
    window.getSelection()?.addRange(range);
    try {
      fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientY: 80 });

      expect(document.body.style.getPropertyValue("user-select")).toBe("none");
      expect(window.getSelection()?.rangeCount).toBe(0);

      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientY: 80 });
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }

    // Released: the page selects its text again.
    expect(document.body.style.getPropertyValue("user-select")).toBe("");
  });

  // The card itself is the handle: a drag icon on the card was one control too
  // many, and the whole card already answers the pointer.
  it("carries no drag icon on its cards", async () => {
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");
    expect(container.querySelectorAll("[data-task-grip]").length).toBe(0);
  });

  // One way into the columns editor: the button beside "Add folder" in the
  // rail. The strip itself ends with the last lane — no add slot, and no
  // per-lane ⋯ menu in the heads.
  it("opens the columns editor from the rail button, not from the strip", async () => {
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    expect(container.querySelector("[data-add-column-lane]")).toBeNull();
    expect(container.querySelectorAll("[data-column]").length).toBe(4);
    expect(screen.queryByRole("button", { name: "Configure column" })).toBeNull();

    const rail = container.querySelector("aside") as HTMLElement;
    await userEvent.click(within(rail).getByRole("button", { name: "Board columns" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelectorAll("[data-column-id]").length).toBe(4);
  });

  // The toolbar's heart narrows the board to its starred cards — a filter over
  // the same lanes, so a starred card is read where it stands, not in a list.
  it("shows only starred cards, each in its own column, while the filter is on", async () => {
    const plain: SessionDto = {
      ...task,
      id: "t4",
      title: "Plain task",
      taskDescription: "Plain task",
    };
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [
        { ...task, favorite: true },
        plain,
        { ...finishedTask, favorite: true, boardColumnId: "col-review" },
      ],
      boardFavoritesOnly: { b1: true },
    });
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    // Starred cards keep their columns and a card of their own.
    expect(container.querySelector('[data-column="todo"] [data-task-id="t1"]')).toBeTruthy();
    expect(
      container.querySelector('[data-column="col-review"] [data-task-id="t2"]'),
    ).toBeTruthy();
    // The unstarred card is filtered out, and the lanes say why they are empty.
    expect(container.querySelector('[data-task-id="t4"]')).toBeNull();
    expect(container.querySelectorAll('[data-task-id]').length).toBe(2);

    // Releasing the filter brings the whole board back.
    useAppStore.setState({ boardFavoritesOnly: { b1: false } });
    await screen.findByText("Plain task");
    expect(container.querySelectorAll("[data-task-id]").length).toBe(3);
  });

  // A stage column is not a place a card can be put by hand — the lifecycle
  // owns it. The drag says so under the pointer instead of quietly doing
  // nothing, and nothing is written on release.
  /** Press a card, move the pointer over a lane and hold it there: the caller
   *  reads what the lane says, then releases the gesture. */
  function hoverOver(card: HTMLElement, lane: HTMLElement) {
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      writable: true,
      value: () => [lane],
    });
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientY: 40 });
    return () => {
      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientY: 40 });
      Reflect.deleteProperty(document, "elementsFromPoint");
    };
  }

  // Todo is the lifecycle's own answer: a card cannot be put back to «not
  // started», so the lane refuses the drop instead of quietly doing nothing.
  it("refuses a drop on Todo, marking it with a cross", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [{ ...finishedTask, boardColumnId: "col-review" }],
    });
    const { container } = renderBoard();
    await screen.findByText("Finished task");

    const card = container.querySelector('[data-task-id="t2"]') as HTMLElement;
    const todoLane = container.querySelector('[data-column="todo"]') as HTMLElement;
    const release = hoverOver(card, todoLane);
    try {
      expect(todoLane.textContent).toContain("✕");
      expect(todoLane.className).toContain("columnDropBlocked");
    } finally {
      release();
    }

    expect(apiMock.updateSession).not.toHaveBeenCalled();
    expect(useAppStore.getState().boardSessions[0]!.boardColumnId).toBe("col-review");
  });

  // Wait takes a card only when there is something to undo — a closed mark or
  // a placement. A Todo card has neither, so dropping it there is refused.
  it("refuses Wait for a card with nothing to release", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [task],
    });
    const { container } = renderBoard();
    await screen.findByText("Fix the login bug");

    const card = container.querySelector('[data-task-id="t1"]') as HTMLElement;
    const waitLane = container.querySelector('[data-column="wait"]') as HTMLElement;
    const release = hoverOver(card, waitLane);
    try {
      expect(waitLane.textContent).toContain("✕");
    } finally {
      release();
    }
    expect(apiMock.updateSession).not.toHaveBeenCalled();
  });

  // Done is a stage door a hand *can* open: dropping the card there is the
  // card's own «Отметить готовой» button, made with the pointer.
  it("marks a card ready when it is dropped on Done", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [finishedTask],
    });
    const { container } = renderBoard();
    await screen.findByText("Finished task");

    const card = container.querySelector('[data-task-id="t2"]') as HTMLElement;
    const doneLane = container.querySelector('[data-column="done"]') as HTMLElement;
    const release = hoverOver(card, doneLane);
    try {
      // The lane says what it will do before the hand lets go.
      expect(doneLane.querySelector('[data-drop-mark="done"]')).toBeTruthy();
    } finally {
      release();
    }

    await waitFor(() => expect(apiMock.updateSession).toHaveBeenCalledTimes(1));
    expect(apiMock.updateSession.mock.calls[0]![1]).toMatchObject({
      doneAt: expect.any(String),
    });
    await waitFor(() =>
      expect(doneLane.querySelector('[data-task-id="t2"]')).toBeTruthy(),
    );
  });

  // Wait is the other door: a closed card dropped there is reopened, and a
  // placement it carried goes with the mark — it is back to the workflow.
  it("reopens a card dropped on Wait and lets go of its placement", async () => {
    useAppStore.setState({
      boards: [{ ...board, columns: [...defaultBoardColumns(), review] }],
      boardSessions: [
        {
          ...finishedTask,
          boardColumnId: "col-review",
          doneAt: "2026-09-21T10:00:00.000Z",
        },
      ],
    });
    const { container } = renderBoard();
    await screen.findByText("Finished task");

    const card = container.querySelector('[data-task-id="t2"]') as HTMLElement;
    const waitLane = container.querySelector('[data-column="wait"]') as HTMLElement;
    const release = hoverOver(card, waitLane);
    try {
      expect(waitLane.querySelector('[data-drop-mark="reopen"]')).toBeTruthy();
    } finally {
      release();
    }

    await waitFor(() => expect(apiMock.updateSession).toHaveBeenCalledTimes(2));
    const patches = apiMock.updateSession.mock.calls.map((call) => call[1]);
    expect(patches).toContainEqual({ doneAt: null });
    expect(patches).toContainEqual({ boardColumnId: null });
  });
});

describe("BoardPage card click", () => {
  // Regression: the click used to await the full session-detail round-trip
  // before navigate(), so the board sat unresponsive for seconds.
  it("opens the chat before the session detail arrives", async () => {
    render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
            <Route path="/chat" element={<div>chat opened</div>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    const card = await screen.findByText("Fix the login bug");
    await userEvent.click(card);

    // Route flipped while getSession is still pending.
    expect(await screen.findByText("chat opened")).toBeTruthy();
    // Selection armed in the same tick: the chat mounts on this task with the
    // skeleton up, not on a previous chat or an empty thread.
    expect(useAppStore.getState().activeSessionId).toBe("t1");
    expect(useAppStore.getState().sessionLoading).toBe(true);
    expect(apiMock.getSession).toHaveBeenCalledWith("t1");
  });
});

describe("Board Done lane order", () => {
  // Done is read as a completion log: the task finished a minute ago belongs
  // above the one finished last week, whatever order they were dragged into.
  it("lists finished tasks newest-first, ignoring the manual order", async () => {
    const finished = (id: string, text: string, doneAt: string, sortOrder: number): SessionDto => ({
      ...task,
      id,
      title: id,
      taskDescription: text,
      startedAt: "2026-09-20T11:00:00.000Z",
      doneAt,
      sortOrder,
      createdAt: "2026-09-20T10:00:00.000Z",
    });
    const older = finished("t-old", "Shipped last week", "2026-09-21T10:00:00.000Z", 0);
    const newest = finished("t-new", "Shipped a minute ago", "2026-09-27T10:00:00.000Z", 5);
    const middle = finished("t-mid", "Shipped yesterday", "2026-09-26T10:00:00.000Z", 2);
    useAppStore.setState({ boardSessions: [older, newest, middle] });

    const { container } = render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Shipped a minute ago");
    const lane = container.querySelector('[data-column="done"] .columnBody, [data-column="done"]');

    const order = Array.from(lane!.querySelectorAll("[data-task-id]")).map((el) =>
      el.getAttribute("data-task-id"),
    );
    expect(order).toEqual(["t-new", "t-mid", "t-old"]);
  });
});

describe("Board Wait lane order", () => {
  // Wait is a finish log as well: the turn that ended a minute ago belongs
  // above one that ended yesterday, whatever order the cards were dragged into.
  it("lists tasks whose turn finished last on top, ignoring the manual order", async () => {
    const finished = (id: string, text: string, updatedAt: string, sortOrder: number): SessionDto => ({
      ...task,
      id,
      title: id,
      taskDescription: text,
      status: "idle",
      startedAt: "2026-09-20T11:00:00.000Z",
      doneAt: null,
      updatedAt,
      sortOrder,
      createdAt: "2026-09-20T10:00:00.000Z",
    });
    const oldest = finished("t-old", "Finished yesterday", "2026-09-26T10:00:00.000Z", 0);
    const newest = finished("t-new", "Finished a minute ago", "2026-09-27T10:00:00.000Z", 5);
    const middle = finished("t-mid", "Finished an hour ago", "2026-09-27T09:00:00.000Z", 2);
    useAppStore.setState({ boardSessions: [oldest, newest, middle] });

    const { container } = render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Finished a minute ago");
    const lane = container.querySelector('[data-column="wait"] .columnBody, [data-column="wait"]');

    const order = Array.from(lane!.querySelectorAll("[data-task-id]")).map((el) =>
      el.getAttribute("data-task-id"),
    );
    expect(order).toEqual(["t-new", "t-mid", "t-old"]);
  });
});

/** The chat a board task opened, with a way back like the browser's. */
function ChatStub() {
  const navigate = useNavigate();
  return (
    <div>
      chat opened
      <button type="button" onClick={() => navigate(-1)}>
        back to board
      </button>
    </div>
  );
}

describe("Board reading position", () => {
  // The board unmounts when a task opens, so without a memory of its lanes the
  // reader comes back to the top and has to hunt for the card they clicked.
  it("returns to the lane and rail they left, with the opened task in view", async () => {
    // Two visits to the board: the one that reads the position, the return.
    apiMock.listBoardSessions
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([task]);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { container } = render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
            <Route path="/chat" element={<ChatStub />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Fix the login bug");
    const todoLane = () =>
      (container.querySelector('[data-column="todo"]') as HTMLElement).children[1] as HTMLElement;
    const rail = () => container.querySelector("aside") as HTMLElement;

    // The reader scrolls the lane and the rail away from the top...
    todoLane().scrollTop = 240;
    todoLane().dispatchEvent(new Event("scroll"));
    rail().scrollTop = 40;
    rail().dispatchEvent(new Event("scroll"));

    // ...opens the task, and comes back.
    await userEvent.click(screen.getByText("Fix the login bug"));
    expect(await screen.findByText("chat opened")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "back to board" }));
    await screen.findByText("Fix the login bug");

    await waitFor(() => expect(todoLane().scrollTop).toBe(240));
    expect(rail().scrollTop).toBe(40);
    // The trip's origin card: nearest means "already on screen — stay put".
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});

describe("Board rail folder filter", () => {
  // Same trip as above, and the same loss: a narrowed rail is a view state the
  // unmounting board has to remember, or coming back shows every project again.
  it("keeps the chosen folder after a task's chat and back", async () => {
    // Two visits again: the one that narrows the rail, the return.
    apiMock.listBoardSessions.mockResolvedValueOnce([task]).mockResolvedValueOnce([task]);

    const { container } = render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
            <Route path="/chat" element={<ChatStub />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Fix the login bug");
    const railRow = () =>
      container.querySelector('[data-rail-cwd="/projects/app"]') as HTMLElement;
    const railBtn = () => railRow().querySelector("button") as HTMLElement;

    await userEvent.click(railBtn());
    expect(railRow().className).toContain(styles.railRowOn);

    await userEvent.click(screen.getByText("Fix the login bug"));
    await userEvent.click(await screen.findByRole("button", { name: "back to board" }));
    await screen.findByText("Fix the login bug");

    await waitFor(() => expect(railRow().className).toContain(styles.railRowOn));
  });
});

describe("BoardPage right-click new task", () => {
  // Right-click on the folder's + opens the standard new-chat picker with the
  // folder locked; confirming it creates the task empty and opens its chat, so
  // the first message forms it — the shape a chat has from the folder tree.
  it("opens the picker, then creates the task with no description", async () => {
    useAppStore.setState({
      adapters: [{ id: "omp", label: "OMP" } as never],
      agentAvailability: { omp: true },
    });
    render(
      <MemoryRouter initialEntries={["/board/b1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/board/:boardId" element={<BoardPage />} />
            <Route path="/chat" element={<div>chat opened</div>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Fix the login bug");
    const group = document.querySelector("[data-group]") as HTMLElement;
    fireEvent.contextMenu(within(group).getByLabelText("New task"));

    // The locked picker, not a silent create.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(apiMock.createSession).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Создать|Create/ }));

    await waitFor(() =>
      expect(apiMock.createSession).toHaveBeenCalledWith({
        boardId: "b1",
        cwd: "/projects/app",
        taskDescription: "",
        provider: "omp",
      }),
    );
    // The empty task never got a title from a description — the server names
    // it from the first message.
    expect(apiMock.createSession.mock.calls[0][0]).not.toHaveProperty("title");
    expect(await screen.findByText("chat opened")).toBeTruthy();
  });
});

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={["/board/b1"]}>
      <I18nProvider>
        <Routes>
          <Route path="/board/:boardId" element={<BoardPage />} />
          {/* A card's chat and a derived chat both navigate here; without the
              route react-router warns on every test that opens one. */}
          <Route path="/chat" element={<div>chat opened</div>} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("BoardPage new task form", () => {
  // The lane's own placeholder is the same door as the group's "+": a project
  // group without tasks shows a card-shaped "Add task" instead of bare space.
  it("opens the form from the Todo lane placeholder", async () => {
    useAppStore.setState({ boardSessions: [] });
    renderBoard();
    await screen.findByText("Add task");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));

    expect(within(group).getByPlaceholderText("Describe the task…")).toBeTruthy();
    // The form takes the placeholder's place rather than stacking on it.
    expect(within(group).queryByRole("button", { name: "Add task" })).toBeNull();
  });

  // The form opens on two rows — one line of text, one row saying in words
  // what the task starts on with the actions beside it — instead of a stack of
  // labelled pickers.
  it("openly compact: one line of text and one line of words, no controls", async () => {
    useAppStore.setState({ boardSessions: [] });
    renderBoard();
    await screen.findByText("Add task");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));
    const textarea = within(group).getByPlaceholderText(
      "Describe the task…",
    ) as HTMLTextAreaElement;
    // One line to start: the box grows with the text instead of opening tall.
    expect(textarea.getAttribute("rows")).toBe("1");

    const box = textarea.closest(`.${styles.composer}`) as HTMLElement;
    const row = box.querySelector(`.${styles.composerFooter}`) as HTMLElement | null;
    expect(row).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Create" })).toBeTruthy();

    // The paperclip keeps the line above, so the info and the two actions read
    // as one row: what the task starts on at the left, what it does at the
    // right, and no third button between them.
    const tools = box.querySelector(`.${styles.composerTools}`) as HTMLElement | null;
    expect(tools).toBeTruthy();
    expect(within(tools).getByRole("button", { name: /^Attach/ })).toBeTruthy();
    expect(within(row).getAllByRole("button").length).toBe(3);

    // What the task starts on is words, not controls: one pressable line that
    // names the agent and the model, and no picker or switch standing in the
    // form at all — those are read far more often than they are changed.
    const line = within(row).getByRole("button", { name: /^What the task starts on:/ });
    expect(line.textContent).toContain("auto");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(row.querySelectorAll(`.${pickerStyles.modelTrigger}`).length).toBe(0);
    // Nothing of the panel until it is asked for.
    expect(screen.queryByRole("dialog", { name: "What the task starts on" })).toBeNull();

    // The press opens the same settings as controls: agent, model, and the
    // start switch with its words on.
    await userEvent.click(line);
    const panel = await screen.findByRole("dialog", { name: "What the task starts on" });
    expect(within(panel).getByRole("switch")).toBeTruthy();

    // The switch keeps what was picked across reloads, so the test takes it from
    // wherever the suite left it: off, where the line says nothing about
    // starting — an off switch is not news, and the line is a summary.
    if (within(panel).getByRole("switch").getAttribute("aria-checked") === "true") {
      await userEvent.click(within(panel).getByRole("switch"));
    }
    await userEvent.click(line);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(line.textContent).not.toContain("Start immediately");
    await userEvent.click(line);
    const reopened = await screen.findByRole("dialog", { name: "What the task starts on" });
    expect(within(reopened).getByRole("switch")).toBeTruthy();
    expect(within(reopened).getByText("Start immediately")).toBeTruthy();
    // Real controls — labels, chevrons, their own menus — but at a row's size:
    // every trigger in the panel is the dense one, none is page-sized. (The
    // model picker joins once the agent has reported its models, so the count
    // itself is the agent's alone here.)
    const dense = reopened.querySelectorAll(`.${pickerStyles.denseTrigger}`);
    expect(dense.length).toBeGreaterThan(0);
    expect(reopened.querySelectorAll(`.${pickerStyles.modelTrigger}`).length).toBe(dense.length);
    expect(reopened.querySelectorAll(`.${pickerStyles.modelTriggerBlock}`).length).toBe(0);
    expect(within(reopened).getByText("Agent")).toBeTruthy();

    // Setting it there is what the line then states, without a control of its
    // own ever standing on the form.
    await userEvent.click(within(reopened).getByRole("switch"));
    await userEvent.click(line);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(line.textContent).toContain("Start immediately");

    // No other block under the textarea: the labelled pickers are gone.
    expect(box.querySelectorAll(`.${styles.composerField}`).length).toBe(0);
    expect(box.querySelectorAll(`.${styles.composerActions}`).length).toBe(0);
  });

  // Regression: the form ignored every press outside it, so an accidental "+"
  // left it in the lane until Cancel was found — an empty form still goes away.
  it("dismisses an empty form on a press outside it", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByLabelText("New task"));
    expect(within(group).getByPlaceholderText("Describe the task…")).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByPlaceholderText("Describe the task…")).toBeNull();
    // Back to the placeholder, and reopening it starts an empty form.
    expect(within(group).getByRole("button", { name: "Add task" })).toBeTruthy();
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));
    expect((within(group).getByPlaceholderText("Describe the task…") as HTMLTextAreaElement).value).toBe("");
  });

  // The report: a press anywhere outside the form dropped it and took the
  // half-written task with it. A form the user has written in stays put.
  it("keeps a typed form and its text on a press outside it", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByLabelText("New task"));
    await userEvent.type(within(group).getByPlaceholderText("Describe the task…"), "Half-typed");

    // Stray presses outside the block, more than once.
    fireEvent.mouseDown(document.body);
    fireEvent.mouseDown(document.body);

    const kept = within(group).getByPlaceholderText(
      "Describe the task…",
    ) as HTMLTextAreaElement;
    expect(kept.value).toBe("Half-typed");
  });

  // The folder's own "+" is outside the form too: pressing it used to reset
  // the form through the same dismissal path and wipe the text.
  it("keeps the text when the same folder's + is pressed again", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByLabelText("New task"));
    await userEvent.type(within(group).getByPlaceholderText("Describe the task…"), "Half-typed");

    await userEvent.click(within(group).getByLabelText("New task"));

    const kept = within(group).getByPlaceholderText(
      "Describe the task…",
    ) as HTMLTextAreaElement;
    expect(kept.value).toBe("Half-typed");
  });

  // Escape (and Cancel) are still the way out of a form with text in it.
  it("drops a typed form on Escape", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByLabelText("New task"));
    await userEvent.type(within(group).getByPlaceholderText("Describe the task…"), "Half-typed");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByPlaceholderText("Describe the task…")).toBeNull();
    expect(within(group).getByRole("button", { name: "Add task" })).toBeTruthy();
  });

  it("keeps the form for a press inside it", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");

    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByLabelText("New task"));
    const textarea = within(group).getByPlaceholderText("Describe the task…");

    fireEvent.mouseDown(textarea);

    expect(screen.getByPlaceholderText("Describe the task…")).toBeTruthy();
  });
});

describe("BoardPage card context menu", () => {
  // Board tasks live outside the chat tree, so the tree row menu never
  // reaches them: the card carries its own context menu, and exporting the
  // task's chat is the entry it opens with.
  it("exports a task's chat from the card's context menu", async () => {
    renderBoard();
    const card = await screen.findByText("Fix the login bug");

    fireEvent.contextMenu(card);

    const menu = screen.getByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Export chat" }));

    // The dialog took over — same title key, so the format radio disambiguates.
    expect(await screen.findByRole("radio", { name: "Markdown (.md)" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dismisses the card menu on a press outside it", async () => {
    renderBoard();
    const card = await screen.findByText("Fix the login bug");

    fireEvent.contextMenu(card);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // A chat born from another one may run on another model and effort: the
  // dialog offers both, and they reach the create call untouched.
  it("creates the derived chat on the model and effort picked in the dialog", async () => {
    // Another test leaves an agent in the registry: with none the dialog falls
    // back to the source chat's own agent, whose catalog this mock answers.
    useAppStore.setState({
      boardSessions: [{ ...task, provider: "cursor" }],
      adapters: [],
      agentAvailability: {},
    });
    // Not `Once`: the catalogs are cached per provider for the module's life,
    // so an earlier test in this file may already have asked (and answered).
    apiMock.listModels.mockResolvedValue({
      ok: true,
      models: [{ value: "gpt-5", name: "GPT-5" }],
      modelParams: [{ id: "effort", name: "Effort", options: [{ value: "high", name: "High" }] }],
    } as never);
    // The effort belongs to the model picked, so it is asked for by name.
    apiMock.getModelParams.mockResolvedValueOnce({
      ok: true,
      modelParams: [{ id: "effort", name: "Effort", options: [{ value: "high", name: "High" }] }],
    } as never);

    // jsdom ships no scrollIntoView; the picker scrolls its list to the pick.
    Element.prototype.scrollIntoView = () => {};
    renderBoard();
    fireEvent.contextMenu(await screen.findByText("Fix the login bug"));
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: /New chat based on this/ }),
    );

    const dialog = await screen.findByRole("dialog", { name: "New chat based on this chat" });
    const pick = async (label: string, option: string) => {
      const field = (await within(dialog).findByText(label)).parentElement as HTMLElement;
      await userEvent.click(within(field).getByRole("button"));
      await userEvent.click(await screen.findByRole("option", { name: option }));
    };
    await pick("Model", "GPT 5");
    await pick("Effort", "High");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiMock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-5", modelParams: { effort: "high" } }),
      ),
    );
  });
});

describe("BoardPage card chat peek", () => {
  /** A task that has run: it sits in Wait, so its chat exists to be read. */
  const ran: SessionDto = {
    ...task,
    startedAt: "2026-09-20T11:00:00.000Z",
  };
  const part = (id: string, messageId: string, text: string) => ({
    id,
    messageId,
    type: "text" as const,
    order: 0,
    payload: { text },
    createdAt: "2026-09-20T11:01:00.000Z",
  });
  const detailWith = (messages: Array<{ id: string; role: "user" | "assistant"; text: string }>) => ({
    ...ran,
    messages: messages.map((m) => ({
      id: m.id,
      sessionId: ran.id,
      role: m.role,
      createdAt: "2026-09-20T11:01:00.000Z",
      parts: [part(`${m.id}-p`, m.id, m.text)],
    })),
  });

  // The report: reading what a running or finished task actually said meant
  // leaving the board for its chat. The card's menu now hands the last turns
  // over to a floating peek, and the board stays where it was.
  it("shows the last turns of a started task without leaving the board", async () => {
    useAppStore.setState({ boardSessions: [ran] });
    apiMock.getSession.mockResolvedValue(
      detailWith([
        { id: "m1", role: "user", text: "Fix the login form" },
        { id: "m2", role: "assistant", text: "Patched the validator" },
      ]),
    );
    renderBoard();

    fireEvent.contextMenu(await screen.findByText("Fix the login bug"));
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Peek at the chat" }),
    );

    const peek = await screen.findByRole("dialog", { name: "Peek at the chat" });
    await waitFor(() => expect(within(peek).getByText("Patched the validator")).toBeTruthy());
    expect(within(peek).getByText("Fix the login form")).toBeTruthy();
    // The chat was read behind the board, not opened on it.
    expect(apiMock.getSession).toHaveBeenCalledWith("t1");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(useAppStore.getState().activeSessionId).toBeNull();
  });

  // A card that has not started has no dialogue to look at.
  it("offers no peek for a task still in Todo", async () => {
    renderBoard();

    fireEvent.contextMenu(await screen.findByText("Fix the login bug"));

    expect(
      within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Peek at the chat" }),
    ).toBeNull();
  });

  it("dismisses the peek on a press outside it", async () => {
    useAppStore.setState({ boardSessions: [ran] });
    apiMock.getSession.mockResolvedValue(detailWith([]));
    renderBoard();

    fireEvent.contextMenu(await screen.findByText("Fix the login bug"));
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Peek at the chat" }),
    );
    await screen.findByRole("dialog", { name: "Peek at the chat" });

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("dialog", { name: "Peek at the chat" })).toBeNull();
  });
});

describe("BoardPage add-task placeholder style", () => {
  // The placeholder is a settings-driven look: the card-shaped block stays the
  // default, a slim row and "off" are the opt-outs for people who read six
  // empty groups as six big dashed buttons.
  it("shows the card-shaped placeholder by default", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");
    useAppStore.setState({ boardSessions: [] });
    expect(await screen.findByText("Add task")).toBeTruthy();
  });

  it("keeps the compact row out of the card shape", async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, boardAddCardStyle: "compact" } });
    renderBoard();
    await screen.findByText("Fix the login bug");
    useAppStore.setState({ boardSessions: [] });

    const button = (await screen.findByText("Add task")) as HTMLElement;
    expect(button.className).toContain(styles.addCardCompact);
  });

  it("renders no placeholder when the style is hidden", async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, boardAddCardStyle: "hidden" } });
    renderBoard();
    await screen.findByText("Fix the login bug");
    useAppStore.setState({ boardSessions: [] });
    expect(screen.queryByText("Add task")).toBeNull();
  });
});

describe("BoardPage file drop", () => {
  /** A drop as the browser reports a file dragged in from the file manager. */
  function dropFile(target: EventTarget, file: File) {
    return fireEvent.drop(target, { dataTransfer: { types: ["Files"], files: [file] } });
  }

  // The new-task form is the one place on the board a file can be attached to,
  // so a file dragged over the board while it is open lands in it as a chip.
  it("attaches a dropped file to the open new-task form", async () => {
    useAppStore.setState({ boardSessions: [] });
    renderBoard();
    await screen.findByText("Add task");
    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));
    within(group).getByPlaceholderText("Describe the task…");

    const taken = dropFile(window, new File(["x"], "plan.pdf", { type: "application/pdf" }));

    // Taken by the form, not followed by the browser: a refused drop is what
    // opened the file in a tab of its own.
    expect(taken).toBe(false);
    await waitFor(() => expect(group.querySelector(`.${styles.fileChip}`)).toBeTruthy());
    expect(group.querySelector(`.${styles.fileChip}`)?.textContent).toContain("plan.pdf");

    // The description names the file as well — the chip below the box is not
    // part of what the task, and so the agent, is told — and the name is
    // painted as the link it is (a textarea cannot colour a range itself).
    const textarea = within(group).getByPlaceholderText(
      "Describe the task…",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("plan.pdf");
    expect(group.querySelector(`.${styles.composerMirrorLink}`)?.textContent).toBe("plan.pdf");
  });

  // Every file is named, not only the last one, and each name is painted as
  // its own link — the description says what the task starts on.
  it("names every dropped file in the description", async () => {
    useAppStore.setState({ boardSessions: [] });
    renderBoard();
    await screen.findByText("Add task");
    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));
    const textarea = within(group).getByPlaceholderText(
      "Describe the task…",
    ) as HTMLTextAreaElement;

    dropFile(window, new File(["x"], "plan.pdf", { type: "application/pdf" }));
    dropFile(window, new File(["x"], "notes.md", { type: "text/markdown" }));

    await waitFor(() => expect(textarea.value).toBe("plan.pdf notes.md"));
    expect(
      Array.from(group.querySelectorAll(`.${styles.composerMirrorLink}`)).map(
        (el) => el.textContent,
      ),
    ).toEqual(["plan.pdf", "notes.md"]);
  });

  // The chip's own press offers the link that names the file — the name the
  // description says, the same thing the chat composer hands over.
  it("copies the file's name from its chip", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    useAppStore.setState({ boardSessions: [] });
    renderBoard();
    await screen.findByText("Add task");
    const group = document.querySelector("[data-group]") as HTMLElement;
    await userEvent.click(within(group).getByRole("button", { name: "Add task" }));
    within(group).getByPlaceholderText("Describe the task…");

    dropFile(window, new File(["x"], "plan.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(group.querySelector(`.${styles.fileChip}`)).toBeTruthy());

    fireEvent.contextMenu(group.querySelector(`.${styles.fileChip}`)!);
    await userEvent.click(await screen.findByText("Copy link to file"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("plan.pdf"));
  });

  // With no form open there is nothing to attach a file to, and the board is
  // still no reason to leave the page: the drop is refused either way.
  it("refuses a file dropped on the board while no form is open", async () => {
    renderBoard();
    await screen.findByText("Fix the login bug");
    const lane = document.querySelector('[data-column="todo"]') as HTMLElement;

    const taken = dropFile(lane, new File(["x"], "plan.pdf", { type: "application/pdf" }));

    expect(taken).toBe(false);
    expect(screen.queryByText("plan.pdf")).toBeNull();
  });
});

