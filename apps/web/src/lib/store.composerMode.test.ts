// @vitest-environment jsdom
//
// The chat's mode is a skill in front of the reader's words, so the prefix has
// to reach the wire — and only there: the field keeps what the reader typed,
// the queue keeps its rows readable, and an explicit `/command` is the reader's
// own instruction rather than a mode's.
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

const SID = "t-mode";

function detail(status: SessionDetailDto["status"] = "idle"): SessionDetailDto {
  return {
    id: SID,
    title: "Mode chat",
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

function row(): SessionDto {
  const { messages: _m, ...rest } = detail();
  return rest;
}

function settle(mode: "agent" | "plan" | "ask" | "investigate") {
  useAppStore.setState({
    sessions: [row()],
    activeSessionId: SID,
    activeSession: detail(),
    sessionDetails: { [SID]: detail() },
    sessionLoading: false,
    inflight: 0,
    inflightBySession: { [SID]: 0 },
    promptEpoch: 0,
    cancelledPromptEpoch: 0,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    promptQueue: [],
    error: null,
    composerModes: { [SID]: mode },
    settings: { ...useAppStore.getState().settings, multitask: false },
  });
}

const sentText = () => apiMock.prompt.mock.calls[0]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  apiMock.prompt.mockResolvedValue(undefined);
});

describe("the chat's mode on the way out", () => {
  it("sends the reader's words with the mode's skill in front", async () => {
    settle("plan");
    await useAppStore.getState().sendPrompt("переписать парсер", { sessionId: SID });
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "/plan переписать парсер", {});
  });

  it("leaves an agent-mode prompt exactly as typed", async () => {
    settle("agent");
    await useAppStore.getState().sendPrompt("переписать парсер", { sessionId: SID });
    expect(sentText()).toBe("переписать парсер");
  });

  it("backs off a command the reader typed themselves", async () => {
    settle("investigate");
    await useAppStore.getState().sendPrompt("/compact", { sessionId: SID });
    expect(sentText()).toBe("/compact");
  });

  it("never puts a mode in front of the harness's own prompt", async () => {
    settle("ask");
    await useAppStore.getState().sendPrompt("задача завершилась", {
      sessionId: SID,
      internal: true,
    });
    expect(sentText()).toBe("задача завершилась");
  });

  it("prepends the mode when a queued prompt is delivered", async () => {
    settle("plan");
    // The agent is mid-turn: the message waits in the queue, readable as typed.
    useAppStore.setState({
      activeSession: detail("running"),
      sessionDetails: { [SID]: detail("running") },
      sessions: [{ ...row(), status: "running" }],
      inflight: 1,
      inflightBySession: { [SID]: 1 },
    });
    await useAppStore.getState().sendPrompt("после шага", { sessionId: SID });
    const item = useAppStore.getState().promptQueue[0]!;
    expect(item.text).toBe("после шага");
    expect(apiMock.prompt).not.toHaveBeenCalled();

    await useAppStore.getState().deliverQueuedPrompt(item.id, "afterStep");
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "/plan после шага", {
      delivery: "afterStep",
    });
  });

  // The mode belongs to the prompt that was written under it, not to the field:
  // switching the field to ask must not turn a queued message into a question.
  it("keeps the mode a prompt was queued in when the field switches", async () => {
    settle("plan");
    useAppStore.setState({
      activeSession: detail("running"),
      sessionDetails: { [SID]: detail("running") },
      sessions: [{ ...row(), status: "running" }],
      inflight: 1,
      inflightBySession: { [SID]: 1 },
    });
    await useAppStore.getState().sendPrompt("после шага", { sessionId: SID });
    const item = useAppStore.getState().promptQueue[0]!;

    useAppStore.getState().setComposerMode(SID, "ask");
    await useAppStore.getState().deliverQueuedPrompt(item.id, "afterStep");
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "/plan после шага", {
      delivery: "afterStep",
    });
  });

  // The chip over a queued request's text writes *that request's* mode (see
  // `setQueuedPromptMode`): the queue is what the pick was about, and the mode
  // the reader last saw on the chip is the one that reaches the wire.
  it("hands a queued prompt over in the mode picked for it", async () => {
    settle("plan");
    useAppStore.setState({
      activeSession: detail("running"),
      sessionDetails: { [SID]: detail("running") },
      sessions: [{ ...row(), status: "running" }],
      inflight: 1,
      inflightBySession: { [SID]: 1 },
    });
    await useAppStore.getState().sendPrompt("после шага", { sessionId: SID });
    const item = useAppStore.getState().promptQueue[0]!;

    useAppStore.getState().setQueuedPromptMode(item.id, "ask");
    expect(useAppStore.getState().promptQueue[0]!.mode).toBe("ask");
    // The chat's own mode is untouched: the next prompt still goes out as plan.
    expect(useAppStore.getState().composerModes[SID]).toBe("plan");

    await useAppStore.getState().deliverQueuedPrompt(item.id, "afterStep");
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "/ask после шага", {
      delivery: "afterStep",
    });
  });

  it("leaves a queued agent-mode prompt alone when the field switches to a mode", async () => {
    settle("agent");
    useAppStore.setState({
      activeSession: detail("running"),
      sessionDetails: { [SID]: detail("running") },
      sessions: [{ ...row(), status: "running" }],
      inflight: 1,
      inflightBySession: { [SID]: 1 },
    });
    await useAppStore.getState().sendPrompt("после шага", { sessionId: SID });
    const item = useAppStore.getState().promptQueue[0]!;

    useAppStore.getState().setComposerMode(SID, "investigate");
    await useAppStore.getState().deliverQueuedPrompt(item.id, "afterStep");
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "после шага", {
      delivery: "afterStep",
    });
  });

  // The drain is the other way out of the queue, and it went through
  // `runSendPrompt`, which read the field's mode at the moment of the send.
  it("drains a queued prompt in the mode it was queued in", async () => {
    settle("agent");
    useAppStore.setState({
      activeSession: detail("running"),
      sessionDetails: { [SID]: detail("running") },
      sessions: [{ ...row(), status: "running" }],
      inflight: 1,
      inflightBySession: { [SID]: 1 },
    });
    await useAppStore.getState().sendPrompt("после шага", { sessionId: SID });

    useAppStore.getState().setComposerMode(SID, "plan");
    // The turn ends: the queue gets a free slot and hands the request over.
    useAppStore.setState({
      activeSession: detail("idle"),
      sessionDetails: { [SID]: detail("idle") },
      sessions: [{ ...row(), status: "idle" }],
      inflight: 0,
      inflightBySession: { [SID]: 0 },
    });
    await useAppStore.getState().drainPromptQueue();
    expect(sentText()).toBe("после шага");
  });
});
