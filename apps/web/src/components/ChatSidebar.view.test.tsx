// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type AdapterMetaDto, type BoardDto, type SessionDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatSidebar } from "./ChatSidebar";
import styles from "./AppShell.module.css";

// The new-chat picker lists the harness's own resumable sessions as it opens.
vi.mock("../lib/api", () => ({ api: { listHarnessSessions: async () => [] } }));

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

function session(id: string, cwd: string): SessionDto {
  return {
    id,
    title: id,
    provider: "omp",
    cwd,
    mode: "agent",
    status: "idle",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId: null,
    taskDescription: null,
    startedAt: null,
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    lastMessageAt: "2026-09-20T10:00:00.000Z",
  };
}

const board: BoardDto = {
  id: "b1",
  name: "Delivery",
  folders: ["E:/proj"],
  sortOrder: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
};

const sessions = [session("s1", "E:/proj"), session("s2", "E:/other")];

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const },
    sessions,
    boards: [board],
    knownFolders: ["E:/proj", "E:/other"],
    activeSessionId: "s1",
    activeSession: { ...sessions[0]!, messages: [] },
    sessionLoading: false,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    adapters: [],
    adaptersLoaded: true,
    agentAvailability: {},
    sidebarOpen: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTree(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <ChatSidebar />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("chat tree selection", () => {
  // Opening a board takes the screen: the chat the reader came from must lose
  // the selection row, and the board row must carry it instead.
  it("marks only the board when a board page is open", () => {
    const { container } = renderTree("/board/b1");

    expect(container.querySelector(`[data-board-id="b1"]`)!.classList).toContain(
      styles.folderHeadActive,
    );
    expect(container.querySelector(`[data-session-id="s1"]`)!.classList).not.toContain(
      styles.active,
    );
  });

  it("marks the open chat when the chat route is active", () => {
    const { container } = renderTree("/chat");

    expect(container.querySelector(`[data-session-id="s1"]`)!.classList).toContain(styles.active);
    expect(container.querySelector(`[data-board-id="b1"]`)!.classList).not.toContain(
      styles.folderHeadActive,
    );
  });
});

describe("new-chat picker", () => {
  const builtin: AdapterMetaDto = {
    id: "builtin",
    label: "Built-in",
    enabled: true,
    family: "builtin",
    commandField: "",
    argsField: "",
    defaultCommand: "",
    defaultArgs: [],
    installHint: "",
    restoreMode: "resume",
    parameterizedModelPicker: false,
    subagentStreaming: false,
    cloudCatalog: false,
    midTurnSteering: false,
    defaultModes: [],
    subagentToolKinds: [],
  };

  // Regression: with only the built-in agent switched on, "Новый чат" said
  // "no agents available" — the picker read a probe that the in-process agent
  // cannot answer (it runs inside the server), while the board kept creating
  // tasks on the very same agent.
  it("offers the built-in agent even when its probe says it is offline", () => {
    useAppStore.setState({
      adapters: [builtin],
      adaptersLoaded: true,
      agentAvailability: { builtin: false },
    });
    const { container } = renderTree("/chat");

    fireEvent.click(container.querySelector<HTMLElement>('[aria-label="Новый чат в папке"]')!);

    expect(screen.queryByText("Сейчас нет доступных агентов")).toBeNull();
    expect(screen.getByText("Built-in")).toBeTruthy();
  });
});

describe("folder menu tree commands", () => {
  /** Right-click a folder head and return the open context menu. */
  async function openFolderMenu(container: HTMLElement) {
    const head = container.querySelector<HTMLElement>('[data-folder-cwd="E:/proj"]')!;
    await userEvent.pointer({ target: head, keys: "[MouseRight]" });
    return screen.getByRole("menu");
  }

  it("folds and unfolds every folder group", async () => {
    const { container } = renderTree("/chat");
    expect(container.querySelectorAll("[data-session-id]").length).toBe(2);

    let menu = await openFolderMenu(container);
    await userEvent.click(screen.getByRole("menuitem", { name: "Свернуть все папки" }));
    expect(menu.isConnected).toBe(false);
    expect(container.querySelectorAll("[data-session-id]").length).toBe(0);

    menu = await openFolderMenu(container);
    await userEvent.click(screen.getByRole("menuitem", { name: "Развернуть все папки" }));
    expect(container.querySelectorAll("[data-session-id]").length).toBe(2);
  });

  // The commands are no-ops in the direction the tree is already in, so they
  // read as dead entries rather than toggles that do nothing.
  it("disables the command that would change nothing", async () => {
    const { container } = renderTree("/chat");

    await openFolderMenu(container);
    expect(
      screen.getByRole("menuitem", { name: "Развернуть все папки" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Свернуть все папки" }).getAttribute("disabled"),
    ).toBeNull();
  });

  // Regression: a chat menu opened over an open folder menu left both on
  // screen, stacked at the same spot — the second opener only cleared its own.
  it("keeps one menu open for the whole tree", async () => {
    const { container } = renderTree("/chat");
    await openFolderMenu(container);

    const row = container.querySelector<HTMLElement>("[data-session-id]")!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 320 });

    expect(screen.getAllByRole("menu").length).toBe(1);
    expect(screen.getByRole("menuitem", { name: "Переименовать" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Архивировать все чаты" })).toBeNull();

    // And back: the folder menu replaces the chat one.
    fireEvent.contextMenu(container.querySelector('[data-folder-cwd="E:/proj"]')!, {
      clientX: 60,
      clientY: 140,
    });
    expect(screen.getAllByRole("menu").length).toBe(1);
    expect(screen.getByRole("menuitem", { name: "Архивировать все чаты" })).toBeTruthy();
  });
});

describe("chat row share command", () => {
  function openChatMenu(container: HTMLElement) {
    fireEvent.contextMenu(container.querySelector<HTMLElement>('[data-session-id="s1"]')!, {
      clientX: 40,
      clientY: 220,
    });
    return screen.getByRole("menu");
  }

  // The row's menu carries the same share a message has, pointed at the chat:
  // the link opens this chat, with no message part.
  it("copies the chat link and shows it by the press", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = renderTree("/chat");

    await userEvent.click(within(openChatMenu(container)).getByRole("menuitem", { name: "Поделиться" }));

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/chat?session=s1`);
    expect(await screen.findByText("Ссылка на чат скопирована")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // The command is the reader's to switch off, like every other one in the
  // "⋯" menu.
  it("is gone when the settings drop it", () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatTreeMenu: ["rename", "delete"] },
    });
    const { container } = renderTree("/chat");

    expect(within(openChatMenu(container)).queryByRole("menuitem", { name: "Поделиться" })).toBeNull();
  });
});

describe("board row menu", () => {
  /** Right-click the board row and return its open context menu. */
  function openBoardMenu(container: HTMLElement) {
    fireEvent.contextMenu(container.querySelector<HTMLElement>('[data-board-id="b1"]')!, {
      clientX: 60,
      clientY: 140,
    });
    return screen.getByRole("menu");
  }

  // Regression: the board row's menu was the one tree menu that ignored the
  // press that closes the others, so it stayed on screen over the page.
  it("closes when the reader presses anywhere else", () => {
    const { container } = renderTree("/board/b1");
    expect(openBoardMenu(container).textContent).toContain("Переименовать");

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  // Regression: the new-chat picker opened over an open row menu, stacking two
  // popovers at the same spot — the picker cleared only the chat menus.
  it("closes when the new-chat picker opens", () => {
    const { container } = renderTree("/board/b1");
    expect(openBoardMenu(container)).toBeTruthy();

    fireEvent.click(container.querySelector<HTMLElement>('[aria-label="Новый чат в папке"]')!);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape", () => {
    const { container } = renderTree("/board/b1");
    expect(openBoardMenu(container)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  // The board row's menu opened off the row's right edge wherever the press
  // landed, while the folder row next to it opened under the pointer: one tree,
  // two answers to the same press. Both menus are now the same component.
  it("opens at the press, exactly like a folder row", () => {
    const { container } = renderTree("/board/b1");

    fireEvent.contextMenu(container.querySelector<HTMLElement>('[data-board-id="b1"]')!, {
      clientX: 200,
      clientY: 300,
    });
    expect([screen.getByRole("menu").style.left, screen.getByRole("menu").style.top]).toEqual([
      "200px",
      "300px",
    ]);

    fireEvent.mouseDown(document.body);

    fireEvent.contextMenu(container.querySelector<HTMLElement>('[data-folder-cwd="E:/proj"]')!, {
      clientX: 200,
      clientY: 300,
    });
    expect([screen.getByRole("menu").style.left, screen.getByRole("menu").style.top]).toEqual([
      "200px",
      "300px",
    ]);
  });
});
