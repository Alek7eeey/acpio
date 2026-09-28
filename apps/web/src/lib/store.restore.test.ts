// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
  health: vi.fn(),
  listBoards: vi.fn(),
  listFolders: vi.fn(),
  fetchAdapters: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

const ACTIVE_SESSION_KEY = "acpio.activeSessionId";
const CHAT_PANES_KEY = "acpio.chatPanes.v1";

function row(id: string, overrides: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return {
    id,
    title: `Chat ${id}`,
    provider: "omp",
    cwd: "C:/proj",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    // A non-empty list tells the store the runtime already answered, so no
    // slash-command polling timer outlives the test.
    slashCommands: [{ name: "help", description: "help" }],
    ...overrides,
  };
}

/**
 * Fresh store module + persisted tab state, exactly like a page reload.
 * A static `import { useAppStore } from "./store"` cannot work: the store keeps
 * module-level session caches and an initial state read from localStorage at
 * import time, so each case must get its own instance via `vi.resetModules()`.
 */
async function boot(opts: { width?: number } = {}) {
  vi.resetModules();
  Object.defineProperty(window, "innerWidth", { value: opts.width ?? 1024, configurable: true });
  const { useAppStore } = await import("./store");
  await useAppStore.getState().loadBootstrap();
  return useAppStore;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiMock.getSettings.mockResolvedValue({});
  apiMock.health.mockResolvedValue({ platform: "linux" });
  apiMock.listBoards.mockResolvedValue([]);
  apiMock.listFolders.mockResolvedValue({ folders: [] });
  apiMock.fetchAdapters.mockResolvedValue([]);
  apiMock.getLiveTurn.mockResolvedValue({ running: false });
  apiMock.listSessions.mockResolvedValue([row("s1"), row("s2")]);
  apiMock.getSession.mockRejectedValue(new Error("session not found"));
});

describe("bootstrap restore of the open chat", () => {
  it("reopens the board task that was active instead of falling back to the chat tree", async () => {
    // The server's chat tree (GET /api/sessions) never lists board tasks, so the
    // stored id cannot be validated against it.
    apiMock.listSessions.mockResolvedValue([row("s2", { title: "Newest chat" })]);
    const task = row("t1", { title: "Board task", boardId: "b1" });
    apiMock.getSession.mockImplementation(async (id: string) => {
      if (id === "t1") return task;
      throw new Error("session not found");
    });
    localStorage.setItem(ACTIVE_SESSION_KEY, "t1");

    const store = await boot();

    expect(store.getState().activeSessionId).toBe("t1");
    expect(store.getState().chatPaneIds).toEqual(["t1"]);
    expect(store.getState().sessions.map((s) => s.id)).toEqual(["s2"]);
    await vi.waitFor(() => expect(store.getState().activeSession?.id).toBe("t1"));
    expect(store.getState().error).toBeNull();
  });

  it("falls back to the newest chat when the stored session no longer exists", async () => {
    localStorage.setItem(ACTIVE_SESSION_KEY, "deleted");

    const store = await boot();

    expect(store.getState().activeSessionId).toBe("s1");
    expect(store.getState().chatPaneIds).toEqual(["s1"]);
  });

  it("keeps a board task in its pane while another chat holds the focus", async () => {
    const task = row("t2", { title: "Board task in pane", boardId: "b1" });
    apiMock.getSession.mockImplementation(async (id: string) => {
      if (id === "t1" || id === "t2") return id === "t2" ? task : row(id, { boardId: "b1" });
      if (id === "s1" || id === "s2") return row(id);
      throw new Error("session not found");
    });
    localStorage.setItem(ACTIVE_SESSION_KEY, "s1");
    localStorage.setItem(CHAT_PANES_KEY, JSON.stringify({ ids: ["s1", "t2"], focus: 0 }));

    const store = await boot({ width: 1440 });

    expect(store.getState().activeSessionId).toBe("s1");
    expect(store.getState().chatPaneIds).toEqual(["s1", "t2"]);
    await vi.waitFor(() => expect(store.getState().sessionDetails.t2?.id).toBe("t2"));
  });
});
