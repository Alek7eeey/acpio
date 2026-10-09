// @vitest-environment jsdom
// The queue bar's delivery buttons: a message the user sent while the agent was
// busy waits for the turn by default (nothing pressed), and two chips hand it
// over right away — `steer` stops the live turn, `afterStep` folds the text into
// it. The server owns those deliveries; the tab only stops tracking the item.
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

const SID = "t-delivery";

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

/** The agent is mid-turn: its own prompt is inflight. */
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
    cancelledPromptEpoch: 0,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    promptQueue: [],
    error: null,
    settings: { ...useAppStore.getState().settings, multitask: false },
  });
}

const queue = () => useAppStore.getState().promptQueue;
const inflight = () => useAppStore.getState().inflightBySession[SID] ?? 0;

/** A message the user sent while the agent was busy — it waits in the queue. */
async function enqueue(text: string): Promise<string> {
  await useAppStore.getState().sendPrompt(text, { sessionId: SID });
  const item = queue()[0];
  if (!item) throw new Error("the message did not land in the queue");
  return item.id;
}

describe("queue delivery buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.prompt.mockResolvedValue(undefined);
    busyState();
  });

  it("leaves a queued message waiting when no chip is pressed", async () => {
    const id = await enqueue("ждёт конца хода");
    expect(apiMock.prompt).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);

    // The default chip is the state the item is already in.
    await useAppStore.getState().deliverQueuedPrompt(id, "queue");

    expect(apiMock.prompt).not.toHaveBeenCalled();
    expect(queue()).toHaveLength(1);
  });

  it("hands a steer to the server at once and counts the turn it starts", async () => {
    const id = await enqueue("прервать и отправить");

    await useAppStore.getState().deliverQueuedPrompt(id, "steer");

    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "прервать и отправить", {
      delivery: "steer",
    });
    expect(queue()).toHaveLength(0);
    // Its own turn: Stop must stay on screen before the first server frame.
    expect(inflight()).toBe(2);
  });

  it("folds an afterStep message into the running turn without counting one", async () => {
    const id = await enqueue("после шага");

    await useAppStore.getState().deliverQueuedPrompt(id, "afterStep");

    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "после шага", {
      delivery: "afterStep",
    });
    expect(queue()).toHaveLength(0);
    // The turn already running answers it — no second turn to count.
    expect(inflight()).toBe(1);
  });

  it("puts the message back when the server never took it", async () => {
    const id = await enqueue("не дошло");
    apiMock.prompt.mockRejectedValueOnce(new Error("Agent is offline"));

    await useAppStore.getState().deliverQueuedPrompt(id, "steer");

    expect(queue().map((q) => q.text)).toEqual(["не дошло"]);
    expect(inflight()).toBe(1);
    expect(useAppStore.getState().error).toBe("Agent is offline");
  });
});