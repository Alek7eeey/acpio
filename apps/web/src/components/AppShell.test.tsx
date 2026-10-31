// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type BoardDto, type SessionDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { AppShell } from "./AppShell";
import styles from "./AppShell.module.css";

vi.mock("../lib/api", () => ({ api: { mcpStatus: async () => ({}) } }));
// The shell picks a page from the path; which page it picked is the whole
// point here, and the pages themselves bring terminals and networks with them.
vi.mock("../pages/ChatPage", () => ({ ChatPage: () => <div data-testid="chat-page" /> }));
vi.mock("../pages/BoardPage", () => ({ BoardPage: () => <div data-testid="board-page" /> }));
vi.mock("../pages/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));
vi.mock("../pages/TasksPage", () => ({ TasksPage: () => <div data-testid="tasks-page" /> }));

// jsdom has no matchMedia, and modules the shell imports read it in their own
// bodies — so it is in place before those imports run, not after them.
vi.hoisted(() => {
  if (typeof window !== "undefined" && !window.matchMedia) {
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
});

function session(id: string, boardId: string | null): SessionDto {
  return {
    id,
    title: id,
    provider: "omp",
    cwd: "E:/proj",
    mode: "agent",
    status: "idle",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId,
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

/** A plain chat, and a task's chat — the one that belongs to the board. */
const chat = session("s1", null);
const task = session("s2", board.id);

function seed(active: SessionDto) {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const },
    sessions: [chat, task],
    boards: [board],
    boardSessions: [],
    knownFolders: ["E:/proj"],
    activeSessionId: active.id,
    activeSession: { ...active, messages: [] },
    sessionLoading: false,
    chatPaneIds: [active.id],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    bgJobs: [],
    adapters: [],
    adaptersLoaded: true,
    agentAvailability: {},
    sidebarOpen: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  seed(chat);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderShell(path: string) {
  // The shell reads the address bar itself (`useBrowserLocation`), so the
  // starting page is set there — as a reload of that URL would set it.
  window.history.replaceState({}, "", path);
  const { container } = render(
    <BrowserRouter>
      <I18nProvider>
        <AppShell />
      </I18nProvider>
    </BrowserRouter>,
  );
  // The header's brand chip: the app's name and version, beside the update
  // chip — the very button the report presses.
  const brand = container.querySelector<HTMLButtonElement>(
    `.${styles.headerBrandSlot} button.${styles.headerBrand}`,
  );
  if (!brand) throw new Error("the header carries no brand chip");
  return brand;
}

describe("the brand chip's way home", () => {
  // The board holds the screen and the tree marks it as the open one, so the
  // chip must leave the reader there — not drop them into the chat that
  // happened to be open before.
  it("keeps the open board open", async () => {
    const brand = renderShell("/board/b1");
    expect(screen.getByTestId("board-page")).toBeTruthy();

    await userEvent.click(brand);

    expect(window.location.pathname).toBe("/board/b1");
    expect(screen.queryByTestId("chat-page")).toBeNull();
    expect(screen.getByTestId("board-page")).toBeTruthy();
    // The press goes nowhere, so the hint names the page rather than a trip.
    expect(brand.getAttribute("title")).toBe("Delivery");
  });

  // A task's chat is opened from the board, and the tree keeps the board lit
  // while the task is read: the same press leads back to it.
  it("returns to the board the open chat belongs to", async () => {
    seed(task);
    const brand = renderShell("/chat");
    expect(screen.getByTestId("chat-page")).toBeTruthy();
    expect(brand.getAttribute("title")).toBe("Назад к доске «Delivery»");

    await userEvent.click(brand);

    expect(window.location.pathname).toBe("/board/b1");
    expect(screen.getByTestId("board-page")).toBeTruthy();
  });

  // No board is lit: the chip is still the way to the chat.
  it("opens the chat when no board is lit", async () => {
    const brand = renderShell("/tasks");
    expect(brand.getAttribute("title")).toBe("Открыть чат");

    await userEvent.click(brand);

    expect(window.location.pathname).toBe("/chat");
    expect(screen.getByTestId("chat-page")).toBeTruthy();
  });
});
