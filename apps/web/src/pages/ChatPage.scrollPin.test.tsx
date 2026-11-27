// @vitest-environment jsdom
//
// Regressions of the follow-the-stream pin, each one a reader who scrolls up and
// is dragged back down:
//
//  - the pin has a second half a frame later, and the reader's wheel can land in
//    between. That frame then scrolled back to the end and re-armed the pin over
//    the reader's intent, so with the reasoning block open at the bottom of a
//    live turn — the thing a thinking model keeps writing — every attempt to
//    scroll up was pulled straight back down;
//  - one wheel notch is ~120px, and the pin's "still at the bottom" tolerance is
//    140px: a reader who nudged the thread up was read as sitting at the end, so
//    the next scroll event (a layout settle, the browser's own anchoring) re-armed
//    the pin and the next chunk pulled them down;
//  - a chat opened while its answer was streaming could not be scrolled at all:
//    every chunk restarted the 120ms timer that ends the open-the-chat pin, so it
//    never ended.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type MessagePartDto, type SessionDetailDto } from "@acpio/shared";
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
/** Every observer the page opens, so a test can report the growth jsdom never
 *  reports by itself — the thread's own box among them. */
const observers: { cb: () => void; el?: Element }[] = [];
(window as unknown as Record<string, unknown>).ResizeObserver = class {
  cb: () => void;
  entry: { cb: () => void; el?: Element };
  constructor(cb: () => void) {
    this.cb = cb;
    this.entry = { cb };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.el = el;
  }
  unobserve() {}
  disconnect() {}
};
/** The transcript's own box grew — what a streamed token reports to the page. */
function grow() {
  act(() => {
    for (const o of observers) {
      if (o.el && String(o.el.className).includes("threadInner")) o.cb();
    }
  });
}
if (!("scrollIntoView" in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

function part(id: string, order: number, text: string): MessagePartDto {
  return {
    id,
    messageId: "a1",
    type: "text",
    order,
    payload: { text },
    createdAt: "2026-10-16T09:33:02.000Z",
  };
}

/** A turn that is still running: its chunks keep asking the pin to follow. */
const detail: SessionDetailDto = {
  id: "s1",
  title: "Чат",
  provider: "builtin",
  cwd: "C:/proj",
  mode: "agent",
  status: "running",
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
      parts: [
        {
          id: "p1",
          messageId: "u1",
          type: "text",
          order: 0,
          payload: { text: "привет" },
          createdAt: "2026-10-16T09:33:00.000Z",
        },
      ],
    },
    {
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      createdAt: "2026-10-16T09:33:01.000Z",
      parts: [part("t1", 0, "думаю")],
    },
  ],
};

function mount() {
  useAppStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      locale: "ru" as const,
      chatMetaChips: [],
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

/** jsdom has no layout: the scrollport gets the metrics the test needs. */
function threadOf(container: HTMLElement) {
  const thread = [...container.querySelectorAll<HTMLElement>('[class*="thread"]')].find(
    (el) => el.classList.length === 1,
  ) as HTMLElement;
  Object.defineProperty(thread, "scrollHeight", { value: 4000, configurable: true });
  Object.defineProperty(thread, "clientHeight", { value: 700, configurable: true });
  return thread;
}

describe("the pin that follows a streaming turn", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("yields to a wheel that lands before its next frame", async () => {
    const { container } = mount();
    const thread = threadOf(container);
    // The chat's own open-the-thread pins settle first (their last timer is
    // 120 ms out, and a busy suite run must not be mistaken for one of them).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    thread.scrollTop = 3300;
    fireEvent.scroll(thread);

    // A chunk lands while the reader sits at the bottom: the pin follows it and
    // leaves its second half queued for the next frame.
    grow();

    // The pin followed the chunk.
    expect(thread.scrollTop).toBe(4000);

    // …and the reader is already scrolling up inside that frame.
    fireEvent.wheel(thread, { deltaY: -120 });
    thread.scrollTop = 3400;
    fireEvent.scroll(thread);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(thread.scrollTop).toBe(3400);
  }, 20_000);

  it("keeps the thread of a reader one wheel notch up", async () => {
    const { container } = mount();
    const thread = threadOf(container);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    thread.scrollTop = 3300;
    fireEvent.scroll(thread);

    // One notch up: 120px of the thread left below the fold, which is inside the
    // 140px the follower treats as "at the bottom".
    fireEvent.wheel(thread, { deltaY: -120 });
    thread.scrollTop = 3180;
    fireEvent.scroll(thread);

    // Past the echo window, something scrolls the thread without moving it — a
    // layout settle, the browser's scroll anchoring under a streaming answer.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    fireEvent.scroll(thread);
    grow();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(thread.scrollTop).toBe(3180);
  }, 20_000);

  it("lets the reader up in a chat opened while its answer streams", async () => {
    const { container } = mount();
    const thread = threadOf(container);

    // The chat opens onto a running turn: a chunk every 50ms, each one a new
    // digest — and so a new run of the pin that opens the chat.
    const chunks = async (ms: number) => {
      let chars = 0;
      const until = Date.now() + ms;
      while (Date.now() < until) {
        chars += 1;
        const next: SessionDetailDto = {
          ...detail,
          messages: [
            detail.messages[0],
            { ...detail.messages[1], parts: [part("t1", 0, "думаю" + ".".repeat(chars))] },
          ],
        };
        act(() => {
          useAppStore.setState({ activeSession: next, sessionDetails: { s1: next } });
        });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      }
    };

    thread.scrollTop = 3300;
    fireEvent.scroll(thread);
    await chunks(250);

    fireEvent.wheel(thread, { deltaY: -400 });
    thread.scrollTop = 2700;
    fireEvent.scroll(thread);
    await chunks(400);

    expect(thread.scrollTop).toBe(2700);
  }, 20_000);
});
