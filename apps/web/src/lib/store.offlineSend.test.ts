// @vitest-environment jsdom
// A prompt sent while the connection is down: the POST never reaches the server,
// so the message must not vanish with the outage — it waits in the queue and is
// handed over as soon as the socket is back.
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

function row(status: SessionDto["status"] = "idle"): SessionDto {
  const { messages: _messages, ...rest } = detail([], status);
  return rest;
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
    error: null,
    connection: "offline",
  });
}

const texts = () =>
  useAppStore
    .getState()
    .activeSession!.messages.flatMap((m) => m.parts.map((p) => String(p.payload.text ?? "")));

describe("a prompt the outage swallowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.listSessions.mockResolvedValue([row()]);
    apiMock.getSession.mockResolvedValue(detail());
    apiMock.getLiveTurn.mockResolvedValue({ running: false, waiting: false });
    apiMock.prompt.mockResolvedValue(undefined);
    boot();
  });

  it("stays with the user instead of disappearing, and goes out after the reconnect", async () => {
    apiMock.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      useAppStore.getState().sendPrompt("важное сообщение", { sessionId: SID }),
    ).rejects.toThrow("Failed to fetch");

    // The message the user typed is still theirs: the queue bar lists it.
    expect(useAppStore.getState().promptQueue.map((q) => q.text)).toEqual(["важное сообщение"]);

    // The socket is back, the server never got the prompt: its own thread is empty.
    useAppStore.setState({ connection: "open" });
    apiMock.getSession.mockResolvedValue(detail());
    await useAppStore.getState().resyncAfterReconnect();

    await vi.waitFor(() =>
      expect(apiMock.prompt).toHaveBeenCalledWith(SID, "важное сообщение", expect.anything()),
    );
    expect(useAppStore.getState().promptQueue).toHaveLength(0);
  });

  it("leaves no phantom bubble behind in the thread", async () => {
    apiMock.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(
      useAppStore.getState().sendPrompt("важное сообщение", { sessionId: SID }),
    ).rejects.toThrow();

    // The pair existed only to be adopted by the server's frames — none are
    // coming, so the thread must not claim the question was sent.
    expect(texts()).not.toContain("важное сообщение");
    expect(useAppStore.getState().error).toBe("Failed to fetch");
  });

  it("keeps a queued message that failed on a drain, instead of dropping it", async () => {
    // The agent is busy, so the message waits in the queue; the drain runs when a
    // slot frees up — and the link is still down at that moment.
    useAppStore.setState({
      sessions: [row("running")],
      activeSession: detail([], "running"),
      sessionDetails: { [SID]: detail([], "running") },
    });
    apiMock.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await useAppStore.getState().sendPrompt("в очереди", { sessionId: SID });
    expect(useAppStore.getState().promptQueue.map((q) => q.text)).toEqual(["в очереди"]);

    apiMock.prompt.mockClear();
    apiMock.prompt.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    useAppStore.setState({
      sessions: [row("idle")],
      activeSession: detail([], "idle"),
      sessionDetails: { [SID]: detail([], "idle") },
    });
    await useAppStore.getState().drainPromptQueue();

    expect(useAppStore.getState().promptQueue.map((q) => q.text)).toEqual(["в очереди"]);
  });
});
