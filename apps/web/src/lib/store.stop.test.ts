// @vitest-environment jsdom
// Stop under a queue: the reader queued a request behind the running turn and
// then pressed Stop. The halt belongs to the turn, not to what they typed — the
// rows stay where they are, and the next free slot hands them over as usual.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailDto, SessionDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { readStoredPromptQueue } from "./promptQueueStorage";
import { useAppStore } from "./store";

const SID = "t-stop";

function detail(status: SessionDetailDto["status"] = "running"): SessionDetailDto {
  return {
    id: SID,
    title: "Busy chat",
    provider: "builtin",
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
    messages: [],
  };
}

function row(status: SessionDto["status"] = "running"): SessionDto {
  const { messages: _m, ...rest } = detail(status);
  return rest;
}

/** The agent is mid-turn: its own prompt is inflight, so a send waits in the queue. */
function busyState() {
  useAppStore.setState({
    sessions: [row("running")],
    activeSessionId: SID,
    activeSession: detail("running"),
    sessionDetails: { [SID]: detail("running") },
    sessionLoading: false,
    inflight: 1,
    inflightBySession: { [SID]: 1 },
    promptEpoch: 0,
    cancelledPromptEpoch: -1,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    promptQueue: [],
    error: null,
    settings: { ...useAppStore.getState().settings, multitask: false },
  });
}

const queue = () => useAppStore.getState().promptQueue;

describe("Stop under a queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    apiMock.prompt.mockResolvedValue(undefined);
    apiMock.cancel.mockResolvedValue({ ok: true });
    busyState();
  });

  it("keeps the queued request instead of eating the text the reader typed", async () => {
    await useAppStore.getState().sendPrompt("вопрос на потом", { sessionId: SID });
    expect(queue().map((q) => q.text)).toEqual(["вопрос на потом"]);
    apiMock.prompt.mockClear();

    await useAppStore.getState().cancelPrompt(SID);

    // The turn stopped ...
    expect(apiMock.cancel).toHaveBeenCalledWith(SID);
    // ... and the request behind it is still there, in the store and in the tab's
    // own copy, so a reload cannot be the second thing that loses it either.
    expect(queue().map((q) => q.text)).toEqual(["вопрос на потом"]);
    expect(readStoredPromptQueue().map((q) => q.text)).toEqual(["вопрос на потом"]);
    // Stop halts work; it does not start the next turn on its own.
    expect(apiMock.prompt).not.toHaveBeenCalled();
  });

  it("hands the kept request over at the next free slot", async () => {
    await useAppStore.getState().sendPrompt("вопрос на потом", { sessionId: SID });
    await useAppStore.getState().cancelPrompt(SID);
    apiMock.prompt.mockClear();

    // The chat is idle again — the drain, wherever it is triggered from, must
    // find the row and send it rather than leave it queued forever.
    useAppStore.setState({
      sessions: [row("idle")],
      activeSession: detail("idle"),
      sessionDetails: { [SID]: detail("idle") },
      inflight: 0,
      inflightBySession: { [SID]: 0 },
    });
    await useAppStore.getState().drainPromptQueue();

    expect(apiMock.prompt).toHaveBeenCalledTimes(1);
    expect(apiMock.prompt.mock.calls[0]![1]).toBe("вопрос на потом");
    expect(queue()).toHaveLength(0);
  });
});
