// @vitest-environment jsdom
//
// A wall of pasted text is offered as a file, and the offer is a question the
// field waits on: until it is answered the composer takes no key, the caret
// sits on the answer, and nothing goes out half-pasted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { composerDraftSnapshot, forgetComposerDraft } from "../lib/composerDrafts";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";

vi.mock("../lib/api", () => {
  // Settings are the whole snapshot, never a bare patch: the store replaces its
  // copy with what a save answers, and an empty answer would take the composer's
  // own chips with it (see `ComposerMetaChips`).
  const echo = async (patch?: Record<string, unknown>) => ({ ...DEFAULT_SETTINGS, ...patch });
  const target: Record<string, unknown> = {
    getSettings: vi.fn(echo),
    updateSettings: vi.fn(echo),
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

/** A block the offer is raised for: past the line count the rule names. */
const BIG_BLOCK = Array.from({ length: 40 }, (_, i) => `строка ${i}`).join("\n");

/** The browser's paste, with the clipboard `onPaste` reads it from. */
function pasteText(input: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files: [], getData: () => text },
  });
  fireEvent(input, event);
}

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
    composerModes: {},
    sendPrompt,
    warnIfHarnessNotConfigured: () => false,
    probeAllAgents: async () => {},
  } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
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

describe("a wall of pasted text", () => {
  it("holds the field until the reader answers", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;

    pasteText(input, BIG_BLOCK);

    // The question says what is waited for, and the field is where the reader
    // would have typed: it takes nothing until the answer is given.
    expect(await screen.findByText("Большой текст — вставить как файл?")).toBeTruthy();
    expect(screen.getByText("Поле ввода ждёт ответа: выберите вариант, и можно печатать дальше"))
      .toBeTruthy();
    expect(input.readOnly).toBe(true);
    expect(input.closest("[class*=pillHeld]")).toBeTruthy();
    // The caret sits on the answer, so a press of Enter is the recommended one.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Вставить файлом" })),
    );

    // Neither a key nor a send gets past the question.
    input.focus();
    await userEvent.type(input, "хвост");
    expect(input.value).toBe("");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();

    // Answered: the block lands where the paste would have, the field opens
    // again, and the caret comes back to it.
    await userEvent.click(screen.getByRole("button", { name: "Вставить текстом" }));
    expect(input.value).toBe(BIG_BLOCK);
    expect(input.readOnly).toBe(false);
    expect(input.closest("[class*=pillHeld]")).toBeNull();
    expect(screen.queryByText("Большой текст — вставить как файл?")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  }, 20_000);
});
