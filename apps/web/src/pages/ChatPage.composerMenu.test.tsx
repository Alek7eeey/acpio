// @vitest-environment jsdom
//
// Right click in the composer offers the quick commands. `/plan` and `/ask`
// send what is typed as the skill's own argument — a draft turned into a plan
// without being retyped — and `commit+push` rides the changes chip's path.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const sendPrompt = vi.fn(async () => {});

beforeEach(() => {
  const detail = emptyChat();
  sendPrompt.mockClear();
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
    promptQueue: [],
    sendPrompt,
    // The gate belongs to the harness settings, not to what this test checks.
    warnIfHarnessNotConfigured: () => false,
  } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("right click in the composer", () => {
  it("sends the draft as the plan skill's argument", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    await userEvent.type(input, "переписать парсер");

    fireEvent.contextMenu(input);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.textContent).toContain("/plan");
    expect(menu.textContent).toContain("/ask");

    await userEvent.click(screen.getByRole("menuitem", { name: "/plan" }));
    expect(sendPrompt).toHaveBeenCalledWith("/plan переписать парсер", {
      sessionId: "s1",
    });
  }, 20_000);

  it("sends the ask skill with an empty draft as the bare command", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;

    fireEvent.contextMenu(input);
    await userEvent.click(screen.getByRole("menuitem", { name: "/ask" }));
    expect(sendPrompt).toHaveBeenCalledWith("/ask", { sessionId: "s1" });
  }, 20_000);
});
