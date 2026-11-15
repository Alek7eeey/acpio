// @vitest-environment jsdom
//
// ↑ in the composer recalls a sent prompt — but only on the second press in a
// row from the first line: one stray press while the caret walks up a draft
// must not swap what was typed for an old message. The whole thing is off in
// Settings → Interface → Chat, where the arrows only move the caret.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { forgetComposerDraft } from "../lib/composerDrafts";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = {
    // The page loads the settings it paints with on mount: an empty answer
    // would replace the switch under test with `undefined`.
    getSettings: vi.fn(async () => useAppStore.getState().settings),
    // The composer bar asks the git chip for its status; the generic proxy's
    // empty object would crash the chip on `files.length`.
    gitStatus: vi.fn(async () => ({
      branch: "dev",
      files: [],
      additions: 0,
      deletions: 0,
      dirty: false,
    })),
  };
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

/** A chat whose one landed prompt is what ↑ would recall. Its turn is running:
 *  an idle chat with no model list loads one on mount, and the composer is
 *  locked until it lands — locked is a different path than the one under test. */
function sentPromptChat(): SessionDetailDto {
  return {
    id: "s1",
    title: "Чат",
    provider: "builtin",
    cwd: "E:/proj",
    mode: "agent",
    status: "running",
    acpSessionId: null,
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    boardId: null,
    taskDescription: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
    messages: [
      {
        id: "u1",
        sessionId: "s1",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            id: "u1-text",
            messageId: "u1",
            type: "text",
            order: 0,
            payload: { text: "прошлый запрос" },
          },
        ],
      },
    ],
  };
}

function setUp(overrides: Record<string, unknown> = {}) {
  // Drafts live outside React, keyed by chat: the recall of one test would come
  // back as typed text in the next.
  forgetComposerDraft("s1");
  const detail = sentPromptChat();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionDetails: { s1: detail },
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    inflight: 1,
    inflightBySession: { s1: 1 },
    promptEpoch: 0,
    cancelledPromptEpoch: 0,
    promptEpochBySession: {},
    cancelledPromptEpochBySession: {},
    pendingQuestion: null,
    promptQueue: [],
  });
}

function renderChat() {
  const view = render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
  const input = view.container.querySelector("textarea")!;
  return { ...view, input };
}

beforeEach(() => setUp());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("↑ in the composer", () => {
  it("recalls a sent prompt on the second press, not the first", () => {
    const { input } = renderChat();
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("прошлый запрос");
  }, 20_000);

  // Consecutive: a key press in between is the reader doing something else.
  it("forgets the first press when another key comes between them", () => {
    const { input } = renderChat();

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Home" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(input.value).toBe("");
  }, 20_000);

  it("never recalls anything when the setting is off", () => {
    setUp({ chatArrowHistory: false });
    const { input } = renderChat();

    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });

    expect(input.value).toBe("");
  }, 20_000);
});
