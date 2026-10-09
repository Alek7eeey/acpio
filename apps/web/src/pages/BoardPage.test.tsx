// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { DEFAULT_SETTINGS, type BoardDto, type SessionDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { BoardPage } from "./BoardPage";
import styles from "./BoardPage.module.css";

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
  mcpDisabledIds: [],
  createdAt: "2026-09-20T10:05:00.000Z",
  updatedAt: "2026-09-20T10:05:00.000Z",
  lastMessageAt: "2026-09-20T10:05:00.000Z",
};

beforeEach(() => {
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    boards: [board],
    boardSessions: [task],
    sessions: [],
    activeSessionId: null,
    activeSession: null,
    sessionLoading: false,
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
