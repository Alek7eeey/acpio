// @vitest-environment jsdom
// Editing a message the reader already sent: it is not one more request behind
// the running turn, it replaces the answer that turn is writing. The old reply
// has to go, the new text has to reach the agent at once, and what stays in the
// thread is that one message — now marked as edited.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto, SessionDetailDto, SessionDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
  prompt: vi.fn(),
  cancel: vi.fn(),
  createSession: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

const SID = "t-edit";
const USER = "u1";
const REPLY = "a1";

const messages: MessageDto[] = [
  {
    id: USER,
    sessionId: SID,
    role: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    parts: [
      {
        id: "u1-text",
        messageId: USER,
        type: "text",
        order: 0,
        payload: { text: "первый вариант" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: REPLY,
    sessionId: SID,
    role: "assistant",
    createdAt: "2026-01-01T00:00:01.000Z",
    parts: [
      {
        id: "a1-text",
        messageId: REPLY,
        type: "text",
        order: 0,
        payload: { text: "ответ, который ещё стримится" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ],
  },
];

function detail(status: SessionDetailDto["status"] = "running", msgs = messages): SessionDetailDto {
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
    messages: msgs,
  };
}

function row(status: SessionDto["status"] = "running"): SessionDto {
  const { messages: _m, ...rest } = detail(status);
  return rest;
}

/** The agent is mid-turn on the answer being edited. */
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

const thread = () =>
  useAppStore.getState().sessionDetails[SID]?.messages ??
  useAppStore.getState().activeSession?.messages ??
  [];

describe("editing a sent message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.prompt.mockResolvedValue(undefined);
    apiMock.cancel.mockResolvedValue({ ok: true });
    busyState();
  });

  it("stops the running answer and sends the edit at once instead of queueing it", async () => {
    await useAppStore.getState().sendPrompt("исправленный текст", {
      sessionId: SID,
      editMessageId: USER,
    });

    // The turn writing the replaced answer is interrupted ...
    expect(apiMock.cancel).toHaveBeenCalledWith(SID);
    // ... and the edit is on the wire, not waiting behind it in the dock.
    expect(apiMock.prompt).toHaveBeenCalledWith(SID, "исправленный текст", {
      editMessageId: USER,
    });
    expect(useAppStore.getState().promptQueue).toHaveLength(0);
    // Stop took the busy marker down; the edit's own turn put it back.
    expect(useAppStore.getState().inflightBySession[SID]).toBe(1);
  });

  it("keeps one message — the edited one — and a fresh reply under it", async () => {
    await useAppStore.getState().sendPrompt("исправленный текст", {
      sessionId: SID,
      editMessageId: USER,
    });

    const msgs = thread();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe(USER);
    expect(msgs[0]!.parts[0]!.payload.text).toBe("исправленный текст");
    // Marked as rewritten right away: the server's own stamp lands later.
    expect(msgs[0]!.editedAt).toBeTruthy();
    // The replaced answer is gone, and one empty bubble waits for the new one.
    expect(msgs.some((m) => m.id === REPLY)).toBe(false);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.parts).toHaveLength(0);
  });

  it("keeps the rest of the queue — those are other questions", async () => {
    useAppStore.setState({
      promptQueue: [
        { id: "q1", text: "вопрос на потом", sessionId: SID, editMessageId: null },
      ],
    });

    await useAppStore.getState().sendPrompt("исправленный текст", {
      sessionId: SID,
      editMessageId: USER,
    });

    expect(apiMock.prompt).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().promptQueue.map((q) => q.text)).toEqual(["вопрос на потом"]);
  });
});
