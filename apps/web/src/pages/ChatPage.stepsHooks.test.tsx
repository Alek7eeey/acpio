// @vitest-environment jsdom
//
// Regression: the interface went blank (React tore the whole tree down —
// "Rendered more hooks than during the previous render") when a turn's block
// stopped being a single item. `StepsSpoiler` folded the parked-question lead-in
// with a `useMemo` *below* two early returns — "no parts yet" and "the caller
// renders the body itself" — so the render that skipped the hook and the render
// that reached it disagreed on the hook count. The reader saw it as the whole
// interface disappearing right after steering a queued message into a chat
// parked on a question, and only a page reload brought it back.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
if (!("scrollIntoView" in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

function part(
  id: string,
  messageId: string,
  type: MessagePartDto["type"],
  order: number,
  payload: Record<string, unknown>,
): MessagePartDto {
  return { id, messageId, type, order, payload, createdAt: "2026-10-16T09:33:02.000Z" };
}

/** The turn as the client has it right after a steer: one item, the question. */
function detail(parts: MessagePartDto[]): SessionDetailDto {
  return {
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
        parts: [part("p1", "u1", "text", 0, { text: "сделай фичу" })],
      },
      {
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        createdAt: "2026-10-16T09:33:01.000Z",
        parts,
      },
    ],
  };
}

const asked = part("c1", "a1", "tool_call", 0, {
  toolCallId: "call_ask",
  title: "ask",
  status: "completed",
});

function mount(d: SessionDetailDto) {
  useAppStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      locale: "ru" as const,
      chatMetaChips: [],
      chatAgentTurnTimeline: true,
    },
    sessions: [d],
    activeSessionId: "s1",
    activeSession: d,
    sessionDetails: { s1: d },
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
}

beforeEach(() => {
  localStorage.setItem("acpio.autoExpandSteps.v3", "1");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("a turn that stops being one item", () => {
  it("keeps the interface instead of tearing the tree down", async () => {
    mount(detail([asked]));
    const { container } = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 100));

    // A settled background job lands on top of the call: two items now, so the
    // block renders its own body instead of the caller's — the render that used
    // to add a hook the one before it had never called.
    useAppStore.getState().handleWsEvent({
      type: "part.appended",
      sessionId: "s1",
      messageId: "a1",
      part: part("x1", "a1", "note", 1, { text: "Фоновая задача завершилась" }),
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(container.textContent).toContain("Фоновая задача завершилась");
    expect(container.querySelector("textarea")).toBeTruthy();
  }, 20_000);
});
