// @vitest-environment jsdom
// The queue holds requests the server was never handed, so a reload has to find
// them again — nothing else has a copy. Against the unfixed store the storage
// stayed empty and these fail.
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
import { readStoredPromptQueue, writeStoredPromptQueue } from "./promptQueueStorage";

const SID = "t-reload";
const KEY = "acpio.promptQueue.v1";

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

/** The agent is mid-turn, so the next prompt waits in the queue. */
function busyState() {
  useAppStore.setState({
    sessions: [row("running")],
    activeSessionId: SID,
    activeSession: detail("running"),
    sessionDetails: { [SID]: detail("running") },
    sessionLoading: false,
    inflight: 1,
    inflightBySession: { [SID]: 1 },
    promptQueue: [],
    error: null,
    settings: { ...useAppStore.getState().settings, multitask: false },
  });
}

describe("the queue across a reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    apiMock.prompt.mockResolvedValue(undefined);
    busyState();
  });

  it("still lists a request the agent was never handed", async () => {
    await useAppStore.getState().sendPrompt("переживи перезагрузку", { sessionId: SID });

    // What a fresh page reads before any pane mounts.
    expect(readStoredPromptQueue().map((q) => q.text)).toEqual(["переживи перезагрузку"]);
    expect(readStoredPromptQueue()[0]?.sessionId).toBe(SID);
  });

  it("drops it once the server owns it", async () => {
    const id = (
      await useAppStore.getState().sendPrompt("уйдёт сразу", { sessionId: SID }),
      useAppStore.getState().promptQueue[0]?.id
    );
    if (!id) throw new Error("the message did not land in the queue");

    await useAppStore.getState().deliverQueuedPrompt(id, "steer");

    expect(useAppStore.getState().promptQueue).toHaveLength(0);
    expect(readStoredPromptQueue()).toEqual([]);
  });

  it("ignores a broken store instead of losing the whole queue", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(readStoredPromptQueue()).toEqual([]);

    writeStoredPromptQueue([
      { id: "q1", text: "целое", sessionId: SID },
      { id: "", text: "без id", sessionId: SID },
      { id: "q3", text: "   ", sessionId: SID },
      { id: "q4", text: "", sessionId: SID, attachments: [{ name: "a.png", path: "C:/a.png" }] },
    ]);

    expect(readStoredPromptQueue().map((q) => q.id)).toEqual(["q1", "q4"]);
  });
});
