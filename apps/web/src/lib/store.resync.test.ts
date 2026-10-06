// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageDto, SessionDetailDto } from "@acpio/shared";

const apiMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getLiveTurn: vi.fn(),
}));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

/** Canonical chat fixture: a running turn with `texts` already on the wire. */
function detail(messages: MessageDto[], overrides: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return {
    id: "s1",
    title: "Chat",
    provider: "omp",
    cwd: "C:/proj",
    mode: "agent",
    status: "running",
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
    ...overrides,
  };
}

function message(id: string, role: MessageDto["role"], texts: string[]): MessageDto {
  return {
    id,
    sessionId: "s1",
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    parts: texts.map((text, i) => ({
      id: `${id}-p${i}`,
      messageId: id,
      type: "text",
      order: i,
      payload: { text },
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

async function flushFrames() {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
}

describe("resyncAfterReconnect", () => {
  beforeEach(() => {
    apiMock.listSessions.mockReset().mockResolvedValue([detail([])]);
    apiMock.getSession.mockReset();
    apiMock.getLiveTurn.mockReset().mockResolvedValue({ running: false });
    useAppStore.setState({
      sessions: [detail([])],
      activeSessionId: "s1",
      sessionDetails: {},
      pendingQuestion: null,
      error: null,
      connection: "open",
    });
  });

  it("adopts the server thread a sleeping device missed while a turn is running", async () => {
    // Local tab painted its optimistic pair; the tablet slept and the agent
    // produced more of the reply, which only the server knows about.
    const local = detail([
      message("local-user-1", "user", ["hi"]),
      message("local-assistant-1", "assistant", ["Hello"]),
    ]);
    useAppStore.setState({ activeSession: local, sessionDetails: { s1: local } });
    apiMock.getSession.mockResolvedValue(
      detail(
        [
          message("srv-user-1", "user", ["hi"]),
          message("srv-assistant-1", "assistant", ["Hello", " world"]),
        ],
        { updatedAt: "2026-01-01T00:00:05.000Z" },
      ),
    );

    await useAppStore.getState().resyncAfterReconnect();

    expect(useAppStore.getState().activeSession?.messages.map((m) => m.id)).toEqual([
      "srv-user-1",
      "srv-assistant-1",
    ]);
  });

  it("keeps the live thread when the snapshot has no messages yet", async () => {
    const local = detail([message("local-user-1", "user", ["hi"])]);
    useAppStore.setState({ activeSession: local, sessionDetails: { s1: local } });
    apiMock.getSession.mockResolvedValue(detail([]));

    await useAppStore.getState().resyncAfterReconnect();

    expect(useAppStore.getState().activeSession?.messages.map((m) => m.id)).toEqual([
      "local-user-1",
    ]);
  });

  it("attaches replayed parts to the adopted assistant message instead of duplicating it", async () => {
    const local = detail([
      message("local-user-1", "user", ["hi"]),
      message("local-assistant-1", "assistant", ["Hello"]),
    ]);
    useAppStore.setState({ activeSession: local, sessionDetails: { s1: local } });
    apiMock.getSession.mockResolvedValue(
      detail([
        message("srv-user-1", "user", ["hi"]),
        message("srv-assistant-1", "assistant", ["Hello"]),
      ]),
    );

    await useAppStore.getState().resyncAfterReconnect();
    useAppStore.getState().handleWsEvent({
      type: "part.appended",
      sessionId: "s1",
      messageId: "srv-assistant-1",
      part: {
        id: "srv-assistant-1-p9",
        messageId: "srv-assistant-1",
        type: "text",
        order: 9,
        payload: { text: " world" },
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    });
    await flushFrames();

    const messages = useAppStore.getState().activeSession?.messages ?? [];
    expect(messages.map((m) => m.id)).toEqual(["srv-user-1", "srv-assistant-1"]);
    expect(messages[1]?.parts.map((p) => p.payload.text)).toEqual(["Hello", " world"]);
  });

  it("replaces the optimistic file part instead of duplicating the attachment chip", async () => {
    // The optimistic user message carries a file part with a name only
    // (size 0, no fileId); the persisted `part.appended` names the same file
    // and must replace it, not stack a second chip under the bubble.
    const local = detail([
      message("local-user-1", "user", ["посмотри"]),
    ]);
    local.messages[0]!.parts.push({
      id: "local-user-1-file-0",
      messageId: "local-user-1",
      type: "file",
      order: 1,
      payload: { name: "clipboard-2026-10-06T14-16-17.png", size: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    useAppStore.setState({ activeSession: local, sessionDetails: { s1: local } });

    useAppStore.getState().handleWsEvent({
      type: "part.appended",
      sessionId: "s1",
      messageId: "local-user-1",
      part: {
        id: "srv-user-1-p1",
        messageId: "local-user-1",
        type: "file",
        order: 1,
        payload: {
          name: "clipboard-2026-10-06T14-16-17.png",
          size: 1_363_148,
          fileId: "f1",
          mime: "image/png",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    });
    await flushFrames();

    const parts = useAppStore.getState().activeSession?.messages[0]?.parts ?? [];
    const fileParts = parts.filter((p) => p.type === "file");
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]?.payload.fileId).toBe("f1");
    expect(fileParts[0]?.payload.size).toBe(1_363_148);
  });
});
