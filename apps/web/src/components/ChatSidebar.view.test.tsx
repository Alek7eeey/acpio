// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type BoardDto, type SessionDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatSidebar } from "./ChatSidebar";
import styles from "./AppShell.module.css";

vi.mock("../lib/api", () => ({ api: {} }));

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
});
