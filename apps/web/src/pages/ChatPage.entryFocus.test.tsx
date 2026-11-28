// @vitest-environment jsdom
//
// Entering a chat is entering a place to write: the caret belongs in the
// composer of the chat that was opened, not wherever the click that opened it
// left it (a sidebar row, a board card). A card waiting for an answer is the
// exception — its arrows and Enter are the answer, so it keeps the keyboard.
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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

// The caret only moves on a desktop pointer (see `shouldAutoFocusComposer`).
window.matchMedia = ((query: string) => ({
  matches: query.includes("pointer: fine"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as never;

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

function chat(id: string, text: string): SessionDetailDto {
  return {
    id,
    title: `Чат ${id}`,
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
    createdAt: "2026-10-16T09:33:00.000Z",
    updatedAt: "2026-10-16T09:33:03.000Z",
    lastMessageAt: "2026-10-16T09:33:03.000Z",
    messages: [
      {
        id: `u-${id}`,
        sessionId: id,
        role: "user",
        createdAt: "2026-10-16T09:33:00.000Z",
        parts: [
          {
            id: `p-${id}`,
            messageId: `u-${id}`,
            type: "text",
            order: 0,
            payload: { text },
            createdAt: "2026-10-16T09:33:00.000Z",
          },
        ],
      },
      {
        id: `a-${id}`,
        sessionId: id,
        role: "assistant",
        createdAt: "2026-10-16T09:33:01.000Z",
        parts: [
          {
            id: `t-${id}`,
            messageId: `a-${id}`,
            type: "text",
            order: 0,
            payload: { text: "готово" },
            createdAt: "2026-10-16T09:33:01.000Z",
          },
        ],
      },
    ],
  };
}

const first = chat("s1", "привет");
const second = chat("s2", "ещё раз");

function mount() {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatMetaChips: [] },
    sessions: [first, second],
    activeSessionId: "s1",
    activeSession: first,
    sessionDetails: { s1: first },
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
    pendingPermission: null,
  });
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

const composerInput = (container: HTMLElement) => container.querySelector("textarea");

describe("the caret on entering a chat", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("lands in the composer of a chat that already has a history", async () => {
    const { container } = mount();
    const input = composerInput(container);
    expect(input).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("follows the reader into the chat they opened next", async () => {
    const { container } = mount();
    const input = composerInput(container);
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The click that opened the next chat took the caret to the sidebar row it
    // came from; the store's switch is the moment the input gets it back.
    (document.activeElement as HTMLElement | null)?.blur();
    useAppStore.setState({
      activeSessionId: "s2",
      activeSession: second,
      sessionDetails: { s1: first, s2: second },
    });
    await waitFor(() => expect(document.activeElement).toBe(composerInput(container)));
  });

  it("stays out of the way of a card waiting for an answer", async () => {
    const { container } = mount();
    const input = composerInput(container);
    await waitFor(() => expect(document.activeElement).toBe(input));
    (document.activeElement as HTMLElement | null)?.blur();
    useAppStore.setState({
      activeSessionId: "s2",
      activeSession: second,
      sessionDetails: { s1: first, s2: second },
      // The question card answers on arrows and Enter: the caret in the input
      // would take the reader's next key away from the answer.
      pendingQuestion: { sessionId: "s2", requestId: "q1", kind: "ask_question", payload: {} },
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(document.activeElement).not.toBe(composerInput(container));
  }, 20_000);
});
