// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailDto, SessionDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
  prompt: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

const SID = "t1";

function detail(status: SessionDetailDto["status"] = "idle"): SessionDetailDto {
  return {
    id: SID,
    title: "Board task",
    provider: "omp",
    cwd: "C:/proj",
    mode: "agent",
    status,
    acpSessionId: "a1",
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId: "b1",
    taskDescription: "do the thing",
    startedAt: "2026-01-01T00:00:00.000Z",
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  };
}

function row(status: SessionDto["status"] = "idle"): SessionDto {
  const { messages: _m, ...rest } = detail(status);
  return rest;
}

function frame(status: SessionDto["status"]) {
  useAppStore.getState().handleWsEvent({
    type: "session.updated",
    sessionId: SID,
    session: row(status),
  });
}

describe("starting a board task right after its turn ended", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.prompt.mockResolvedValue(undefined);
    useAppStore.setState({
      sessions: [],
      boardSessions: [row("idle")],
      activeSessionId: SID,
      activeSession: detail("idle"),
      sessionDetails: { [SID]: detail("idle") },
      sessionLoading: false,
      inflight: 0,
      inflightBySession: {},
      promptEpoch: 0,
      cancelledPromptEpoch: 0,
      promptEpochBySession: {},
      cancelledPromptEpochBySession: {},
      promptQueue: [],
      settings: { ...useAppStore.getState().settings, multitask: false },
    });
  });

  it("sends the second start instead of queueing it behind a stale idle frame", async () => {
    // Turn 1: the board's start button sends the description.
    await useAppStore.getState().sendPrompt("start work", { sessionId: SID });
    expect(apiMock.prompt).toHaveBeenCalledTimes(1);

    // Turn 1 finishes: the terminal idle frame reaches the tab.
    frame("idle");
    expect(useAppStore.getState().inflightBySession[SID] ?? 0).toBe(0);

    // The user clicks Start again. It must reach the wire, not the queue.
    await useAppStore.getState().sendPrompt("start work", { sessionId: SID });
    expect(apiMock.prompt).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().promptQueue).toHaveLength(0);
  });

  it("sends the second start when the idle frame lands as the prompt goes out", async () => {
    let releasePrompt!: () => void;
    apiMock.prompt.mockImplementation(
      () => new Promise<void>((res) => (releasePrompt = res)),
    );

    // Turn 1 is on the wire (not yet resolved), the user clicks Start on
    // another card: the previous turn's idle frame is still in flight.
    const send = useAppStore.getState().sendPrompt("start work", { sessionId: SID });
    frame("idle");
    releasePrompt();
    await send;

    // Turn 2: the fresh click must go to the wire too.
    apiMock.prompt.mockResolvedValue(undefined);
    await useAppStore.getState().sendPrompt("start work", { sessionId: SID });
    expect(apiMock.prompt).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().promptQueue).toHaveLength(0);
  });
});