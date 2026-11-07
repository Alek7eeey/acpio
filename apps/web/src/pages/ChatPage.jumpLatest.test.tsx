// @vitest-environment jsdom
//
// Regression: with a long reasoning block expanded at the bottom of a chat, the
// floating "jump to the latest" pill sat right under the thumb, and it acted on
// the *press* — so every swipe that started on it threw the reader back to the
// bottom of the transcript and nothing above it could be reached. A gesture is
// a tap only when it ends as a click, so the pill answers the click.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

const detail: SessionDetailDto = {
  id: "s1",
  title: "Чат",
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
      id: "u1",
      sessionId: "s1",
      role: "user",
      createdAt: "2026-10-16T09:33:00.000Z",
      parts: [{ id: "p1", messageId: "u1", type: "text", order: 0, payload: { text: "привет" }, createdAt: "2026-10-16T09:33:00.000Z" }],
    },
    {
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      createdAt: "2026-10-16T09:33:01.000Z",
      parts: [
        {
          id: "t1",
          messageId: "a1",
          type: "text",
          order: 0,
          payload: { text: "привет" },
          createdAt: "2026-10-16T09:33:01.000Z",
        },
      ],
    },
  ],
};

function mount() {
  useAppStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      locale: "ru" as const,
      chatMetaChips: [],
      chatAgentTurnTimeline: true,
    },
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
  });
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

/** The scrollport, dressed with the metrics jsdom has no layout for: scrolled
 *  far enough from the end that the pill belongs on screen. */
function scrolledAwayThread(container: HTMLElement) {
  const thread = [...container.querySelectorAll<HTMLElement>('[class*="thread"]')].find(
    (el) => el.classList.length === 1,
  ) as HTMLElement;
  Object.defineProperty(thread, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(thread, "clientHeight", { value: 700, configurable: true });
  fireEvent.scroll(thread);
  return thread;
}

describe("the jump-to-latest pill", () => {
  beforeEach(() => {
    localStorage.setItem("acpio.autoExpandSteps.v3", "1");
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("ignores the press and answers the click", async () => {
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 100));
    scrolledAwayThread(container);

    const pill = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[class*="jumpLatest"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    // A swipe that starts on the pill is the reader scrolling, not a tap.
    fireEvent.pointerDown(pill);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[class*="jumpLatest"]')).toBeTruthy();

    // The tap itself still takes them to the end of the thread.
    fireEvent.click(pill);
    await waitFor(() => expect(container.querySelector('[class*="jumpLatest"]')).toBeNull());
  }, 20_000);
});
