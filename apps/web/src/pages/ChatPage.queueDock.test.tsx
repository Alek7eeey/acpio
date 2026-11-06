// @vitest-environment jsdom
//
// Regression: the queue of requests waiting for the agent was a block above the
// whole composer, so in a chat whose first prompt never landed — the empty state
// that centres the input in the pane — the queue pinned itself to the top of the
// screen while the input sat in the middle. The queue belongs to the composer:
// it rides inside it and stays on the line right above the input.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = {};
  return {
    api: new Proxy(target, {
      get: (t, prop: string) => {
        if (prop === "then") return undefined;
        if (!(prop in t)) t[prop] = vi.fn(async () => ({}));
        return t[prop];
      },
    }),
  };
});
vi.mock("../lib/useSessionSocket", () => ({ useSessionSocket: () => {} }));

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
}
if (!("ResizeObserver" in window)) {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!("scrollIntoView" in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

/** A chat whose first prompt never reached the agent: no message, and the
 *  requests it left behind wait in the queue. */
function emptyChat(): SessionDetailDto {
  return {
    id: "s1",
    title: "Новый чат",
    provider: "builtin",
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
  };
}

beforeEach(() => {
  const detail = emptyChat();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatMetaChips: [] },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionDetails: { s1: detail },
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    inflight: 0,
    inflightBySession: { s1: 0 },
    promptEpoch: 0,
    cancelledPromptEpoch: 0,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    pendingQuestion: null,
    promptQueue: [
      { id: "q1", text: "первый запрос", sessionId: "s1", editMessageId: null, attachments: undefined },
      { id: "q2", text: "второй запрос", sessionId: "s1", editMessageId: null, attachments: undefined },
    ],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the prompt queue of an empty chat", () => {
  it("rides inside the composer instead of hanging above it", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 100));

    const queue = container.querySelector("[data-prompt-queue]");
    expect(queue?.textContent).toContain("первый запрос");
    // The composer's own block: the one that holds the input. An empty chat
    // centres it, so anything left outside it lands at the top of the pane.
    const composer = container.querySelector("textarea")?.closest("form");
    expect(composer).toBeTruthy();
    expect(composer!.contains(queue!)).toBe(true);
  }, 20_000);
});
