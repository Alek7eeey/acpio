// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto, SessionDetailDto, SessionDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
  prompt: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

const SID = "s1";

function detail(messages: MessageDto[] = [], status: SessionDetailDto["status"] = "idle"): SessionDetailDto {
  return {
    id: SID,
    title: "Chat",
    provider: "omp",
    cwd: "C:/proj",
    mode: "agent",
    status,
    acpSessionId: "a1",
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    mcpDisabledIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages,
  };
}

function textMessage(id: string, role: MessageDto["role"], text: string): MessageDto {
  return {
    id,
    sessionId: SID,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    parts: [
      {
        id: `${id}-p0`,
        messageId: id,
        type: "text",
        order: 0,
        payload: { text },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

/** The tree row — the chat sidebar is built from it, board tasks have none. */
function row(status: SessionDto["status"] = "idle"): SessionDto {
  const { messages: _messages, slashCommands: _slash, ...rest } = detail([], status);
  return rest;
}

/** What the composer and Stop button read: the pane status plus this tab's prompts. */
function busy(): boolean {
  const state = useAppStore.getState();
  return (
    (state.inflightBySession?.[SID] ?? 0) > 0 ||
    state.activeSession?.status === "running" ||
    state.activeSession?.status === "waiting"
  );
}

function boot() {
  useAppStore.setState({
    sessions: [row()],
    activeSessionId: SID,
    activeSession: detail(),
    sessionDetails: { [SID]: detail() },
    sessionLoading: false,
    inflight: 0,
    inflightBySession: {},
    promptEpoch: 0,
    cancelledPromptEpoch: 0,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    promptQueue: [],
  });
}

function frame(status: SessionDto["status"]) {
  useAppStore.getState().handleWsEvent({
    type: "session.updated",
    sessionId: SID,
    session: row(status),
  });
}

/** Start a prompt and wait for this tab to paint the turn as running. */
async function startTurn() {
  await useAppStore.getState().sendPrompt("hi", { sessionId: SID });
  await vi.waitFor(() => expect(useAppStore.getState().activeSession?.status).toBe("running"));
  frame("running");
}

/** The last assistant message holds a tool row the agent never reported as done. */
function leaveToolRunning() {
  const live = useAppStore.getState().activeSession!;
  const last = live.messages[live.messages.length - 1]!;
  const messages = [...live.messages];
  messages[messages.length - 1] = {
    ...last,
    parts: [
      {
        id: "tool-1",
        messageId: last.id,
        type: "tool_call",
        order: 1,
        payload: { status: "running", title: "Bash" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const next = { ...live, messages };
  useAppStore.setState({
    activeSession: next,
    sessionDetails: { ...useAppStore.getState().sessionDetails, [SID]: next },
  });
}

describe("end of turn settles the chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listSessions.mockResolvedValue([row()]);
    apiMock.getSession.mockResolvedValue(detail());
    apiMock.getLiveTurn.mockResolvedValue({ running: false, waiting: false });
    apiMock.prompt.mockResolvedValue(undefined);
    boot();
  });

  it("unlocks after a turn the tree row watched end to end", async () => {
    await startTurn();
    frame("idle");
    expect(busy()).toBe(false);
  });

  it("unlocks when the prompt itself failed", async () => {
    apiMock.prompt.mockRejectedValueOnce(new Error("boom"));
    await expect(useAppStore.getState().sendPrompt("hi", { sessionId: SID })).rejects.toThrow(
      "boom",
    );
    expect(busy()).toBe(false);
  });

  it("unlocks after a reconnect whose resync found no live turn", async () => {
    await startTurn();
    // The terminal frame went out while the socket was down — it never arrives.
    apiMock.getSession.mockResolvedValue(
      detail([textMessage("m1", "user", "hi"), textMessage("m2", "assistant", "done")]),
    );
    await useAppStore.getState().resyncAfterReconnect();
    expect(busy()).toBe(false);
  });

  it("unlocks when the chat has no tree row at all (board task)", async () => {
    useAppStore.setState({ sessions: [] });
    await startTurn();
    frame("idle");
    expect(busy()).toBe(false);
  });

  it("unlocks when a list refresh settled the row before the terminal frame", async () => {
    await startTurn();
    // `listSessions` read the row after the DB write, before this frame landed.
    useAppStore.setState({ sessions: [row("idle")] });
    frame("idle");
    expect(busy()).toBe(false);
  });

  it("unlocks when the last tool part still looks live at the terminal frame", async () => {
    await startTurn();
    leaveToolRunning();
    apiMock.getSession.mockResolvedValue(detail());
    frame("idle");
    // The steps block is still up — the row genuinely looks unfinished here.
    expect(busy()).toBe(true);
    await vi.waitFor(() => expect(busy()).toBe(false), { timeout: 4000 });
  });
});
