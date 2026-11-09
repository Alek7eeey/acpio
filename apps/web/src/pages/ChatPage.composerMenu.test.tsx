// @vitest-environment jsdom
//
// Right click in the composer offers the quick commands, and only writes them
// into the field: the draft becomes the skill's own argument — a draft turned
// into a plan without being retyped — and the reader's Enter is what sends it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { composerDraftSnapshot, forgetComposerDraft } from "../lib/composerDrafts";
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
// The git rows of the menu depend on the composer's repo: the hook answers
// with whatever the case set, no socket and no git behind it.
const gitMock = vi.hoisted(() => ({ status: null as unknown }));
vi.mock("../components/ComposerGitBar", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useGitStatus: () => ({
      status: gitMock.status,
      loading: false,
      awaiting: false,
      refresh: async () => {},
      checkout: async () => {},
      deleteBranch: async () => ({ ok: true }),
      branchBusy: false,
      branchesLoading: false,
      loadBranches: async () => {},
      applyStatus: () => {},
    }),
  };
});

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
  gitMock.status = null;
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
  // The draft registry lives outside React and the store: the text one case
  // typed would be waiting in the field of the next one.
  for (const key of Object.keys(composerDraftSnapshot())) forgetComposerDraft(key);
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
  const menuOf = (input: HTMLElement) => {
    fireEvent.contextMenu(input);
    return document.querySelector('[role="menu"]')!;
  };

  it("writes the draft into the field as the plan skill's argument", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    await userEvent.type(input, "переписать парсер");

    const menu = menuOf(input);
    expect(menu.textContent).toContain("/plan");
    expect(menu.textContent).toContain("/ask");

    await userEvent.click(screen.getByRole("menuitem", { name: "/plan" }));
    // Nothing left the input: the draft is now the command's argument, and the
    // reader decides when it goes out.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("/plan переписать парсер");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }, 20_000);

  it("writes the bare command with the space its argument follows", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;

    menuOf(input);
    await userEvent.click(screen.getByRole("menuitem", { name: "/ask" }));
    expect(sendPrompt).not.toHaveBeenCalled();
    // The caret sits after the space: typing continues the argument instead of
    // growing the command's name.
    expect(input.value).toBe("/ask ");
  }, 20_000);

  it("offers the skill commands alone", async () => {
    const { container } = renderChat();
    menuOf(container.querySelector("textarea")!);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/plan",
      "/ask",
    ]);
  }, 20_000);

  it("writes the git command into the field instead of sending it", async () => {
    gitMock.status = {
      repo: "C:/proj",
      branch: "main",
      dirty: true,
      files: [],
      additions: 1,
      deletions: 0,
      conflict: false,
    };
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    await userEvent.type(input, "переписать парсер");
    const menu = menuOf(input);
    expect(menu.textContent).toContain("commit+push");

    await userEvent.click(screen.getByRole("menuitem", { name: "commit+push" }));
    // Same as the skill rows: the command waits in the field for Enter.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("commit+push переписать парсер");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }, 20_000);
});
