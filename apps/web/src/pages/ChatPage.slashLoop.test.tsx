// @vitest-environment jsdom
//
// Regression: switching chats crashed the interface with React error #185
// ("Maximum update depth exceeded"). The chat pane reads its session through
// `useAppStore((s) => selectLiveSessionDetail(s, id))`, and that selector
// hydrates the stored snapshot from the slash-command cache. Hydration spread
// into a fresh object whenever the warm cache held a command the snapshot had
// not got — which a snapshot committed by a raw GET (the pane prefetch, the boot
// restore) regularly is — so every `getSnapshot` call answered with a new
// object, React saw the snapshot change on every read, and the render loop
// ended at #185. A selector has to answer the same state with the same object.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto, type SlashCommandDto } from "@acpio/shared";
import { selectLiveSessionDetail, useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";

const commands: SlashCommandDto[] = [
  { name: "compact", description: "Compact" },
  { name: "goal-loop", description: "Goal loop" },
];

const detail: SessionDetailDto = {
  id: "s1",
  title: "чат_тест_switch",
  provider: "builtin",
  cwd: "E:/proj",
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
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:05.000Z",
  lastMessageAt: "2026-10-01T09:00:05.000Z",
  slashCommands: commands,
  messages: [],
};

const apiMock = vi.hoisted(() => ({
  getSession: vi.fn(async () => detail as unknown as SessionDetailDto),
}));

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = { getSession: apiMock.getSession };
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

beforeEach(() => {
  apiMock.getSession.mockClear();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionDetails: { s1: detail },
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    modelsCatalog: null,
    modelsLoading: false,
    pendingQuestion: null,
    pendingPermission: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** A snapshot committed without the warm cache — what `commitDetail` does with
 *  a raw `GET /api/sessions/:id` (the split-pane prefetch, the boot restore). */
function commitRawSnapshot() {
  useAppStore.setState((s) => {
    const raw = { ...s.activeSession!, slashCommands: [] };
    return { activeSession: raw, sessionDetails: { ...s.sessionDetails, s1: raw } };
  });
}

describe("chat switch with a warm slash-command cache", () => {
  it("reads the same snapshot twice instead of a fresh one per read", async () => {
    // The first read warms the client cache — `selectSession` merges what GET
    // returned into it (`preferSlashCommands`).
    await useAppStore.getState().selectSession("s1");
    commitRawSnapshot();

    const first = selectLiveSessionDetail(useAppStore.getState(), "s1");
    expect(first?.slashCommands?.map((c) => c.name)).toEqual(["compact", "goal-loop"]);
    expect(selectLiveSessionDetail(useAppStore.getState(), "s1")).toBe(first);
  });

  it("keeps the chat pane rendering instead of looping to React #185", async () => {
    await useAppStore.getState().selectSession("s1");
    commitRawSnapshot();

    expect(() =>
      render(
        <MemoryRouter initialEntries={["/chat"]}>
          <I18nProvider>
            <ChatPage />
          </I18nProvider>
        </MemoryRouter>,
      ),
    ).not.toThrow(/Maximum update depth/);
  });
});
