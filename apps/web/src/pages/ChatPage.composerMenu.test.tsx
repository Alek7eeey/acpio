// @vitest-environment jsdom
//
// Right click in the composer switches the chat's mode: the modes are skills
// (`plan`, `ask`, `investigate`) the reader never types — the prefix lands on
// the way out, the bubble hides it again and shows the mode over the message.
// The basic editing rows (paste, select all, undo, redo) come after them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type MessageDto, type SessionDetailDto } from "@acpio/shared";
import { composerDraftSnapshot, forgetComposerDraft } from "../lib/composerDrafts";
import { api } from "../lib/api";
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

/** A prompt the reader sent in plan mode: the skill rides in the message text. */
function planMessage(): MessageDto {
  return {
    id: "m-plan",
    sessionId: "s1",
    role: "user",
    createdAt: "2026-01-01T00:00:01.000Z",
    parts: [
      {
        id: "m-plan-text",
        messageId: "m-plan",
        type: "text",
        order: 0,
        payload: { text: "/plan переписать парсер" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ],
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
    // The mode is the browser's, so a case that switched must not hand it on.
    composerModes: {},
    sendPrompt,
    // The gate belongs to the harness settings, not to what this test checks.
    warnIfHarnessNotConfigured: () => false,
    // Nor does the agent probe: its mocked answer (`{}`) replaces the whole
    // settings snapshot when it lands, and a longer case would render into it.
    probeAllAgents: async () => {},
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

  it("offers the chat's modes, then the basic editing rows", async () => {
    const { container } = renderChat();
    menuOf(container.querySelector("textarea")!);
    // No repo in this case: the git rows are absent, and the field's own
    // editing rows follow the modes.
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Агент",
      "План",
      "Вопрос",
      "Разбор",
      "Вставить",
      "Выделить всё",
      "Отменить",
      "Повторить",
    ]);
    // A default chat is in agent mode, and the row says so.
    expect(
      screen.getByRole("menuitem", { name: "Агент" }).getAttribute("aria-current"),
    ).toBe("true");
  }, 20_000);

  // The four rows live in the chip above the field: a press on it is the whole
  // gesture, on a mouse and on a phone alike, and the paperclip keeps both of
  // its own doors (the attach tests hold that half).
  it("offers the modes from the chip above the field", async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru", chatMetaChips: ["promptMode"] },
    } as never);
    const { container } = renderChat();
    const chip = screen.getByRole("button", { name: "Режим промпта: Агент" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    // The row's name is the mode itself: the line under it is a description,
    // so a screen reader reads the picker as four modes and not as four
    // paragraphs.
    expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Агент",
      "План",
      "Вопрос",
      "Разбор",
    ]);

    await userEvent.click(screen.getByRole("menuitem", { name: "План" }));
    // The chip is where the mode is read now, and the popup went with the pick.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Режим промпта: План" })).toBeTruthy();
    expect(container.querySelector('[data-composer-mode="plan"]')).toBeTruthy();
    expect(localStorage.getItem("acpio.composerModes.v1")).toContain('"s1":"plan"');

    // A rest over the paperclip offers nothing in a chat: the mode is the
    // chip's, and the button keeps its own two doors.
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^Прикрепить/ }));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole("menu")).toBeNull();
  }, 20_000);

  // Every door to the mode is a press on a menu that closes itself, and the
  // mode is only worth switching to write in it: the caret goes back into the
  // field without a second click, whichever door was used.
  it("hands the caret back to the field after a pick", async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru", chatMetaChips: ["promptMode"] },
    } as never);
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;

    // The chip over the field.
    await userEvent.click(screen.getByRole("button", { name: "Режим промпта: Агент" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "План" }));
    await waitFor(() => expect(document.activeElement).toBe(input));

    // The field's own right click.
    menuOf(input);
    await userEvent.click(screen.getByRole("menuitem", { name: "Вопрос" }));
    await waitFor(() => expect(document.activeElement).toBe(input));

    // The cross on the mode's pill, which is the way back to agent.
    await userEvent.click(screen.getByRole("button", { name: "Вернуться к агенту" }));
    await waitFor(() => expect(document.activeElement).toBe(input));
  }, 20_000);

  // On a phone the paperclip keeps its two doors: a tap picks a file from the
  // device, a long press (the browser's own contextmenu) from the server. The
  // mode never answers either of them.
  it("keeps the paperclip's two doors on touch", async () => {
    // The dialog lists a folder as soon as it opens: an empty one is enough.
    (api as unknown as Record<string, unknown>).browseDirectory = vi.fn(async () => ({
      path: "C:/",
      parent: null,
      entries: [],
    }));
    renderChat();
    const paperclip = screen.getByRole("button", { name: /^Прикрепить/ });

    fireEvent.contextMenu(paperclip);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  }, 20_000);

  // The report: the menu outlived the first keystroke and sat over the words
  // being written into the field; a press outside closed it, a letter did not.
  it("steps aside as soon as the reader types", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    menuOf(input);
    expect(screen.queryByRole("menu")).toBeTruthy();

    // The field is focused by the press; typing is what follows it.
    input.focus();
    await userEvent.type(input, "п", { skipClick: true });

    expect(screen.queryByRole("menu")).toBeNull();
    // The letter is the field's: closing the menu never eats the keystroke.
    expect(input.value).toBe("п");
  }, 20_000);

  it("switches the chat's mode without touching the draft", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    await userEvent.type(input, "переписать парсер");

    menuOf(input);
    await userEvent.click(screen.getByRole("menuitem", { name: "План" }));

    // The mode is the chat's, not the message's: nothing is sent, and the
    // reader's words stay exactly as typed.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("переписать парсер");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // The mode outlives the page — it is the chat's until it is switched back —
    // and the field wears it in the mode's colour beside the paperclip.
    expect(container.querySelector('[data-composer-mode="plan"]')).toBeTruthy();
    expect(localStorage.getItem("acpio.composerModes.v1")).toContain('"s1":"plan"');

    // The right click still opens the switcher, with the check on the mode in
    // force.
    menuOf(input);
    expect(
      screen.getByRole("menuitem", { name: "План" }).getAttribute("aria-current"),
    ).toBe("true");
  }, 20_000);

  // Shift alone over the empty field steps the ring of modes and wraps at the
  // end: the whole switcher without opening it. It is a press the key makes on
  // its own — a Shift that types a capital letter is that letter's, not a step,
  // and a field already written in is the reader's to type in.
  it("steps the mode on a Shift press alone", async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru", chatMetaChips: ["promptMode"] },
    } as never);
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    /** The mode the chat is in: agent is the absence of an entry. */
    const mode = () => useAppStore.getState().composerModes["s1"] ?? "agent";
    const shiftTap = () => {
      fireEvent.keyDown(input, { key: "Shift", shiftKey: true });
      fireEvent.keyUp(input, { key: "Shift" });
    };

    shiftTap();
    expect(mode()).toBe("plan");
    // The chip above the field wears the mode the press reached, exactly as a
    // row of its menu would have.
    expect(screen.getByRole("button", { name: "Режим промпта: План" })).toBeTruthy();
    shiftTap();
    expect(mode()).toBe("ask");
    shiftTap();
    expect(mode()).toBe("investigate");
    // The last mode wraps back to the first, and the ring starts over.
    shiftTap();
    expect(mode()).toBe("agent");
    expect(screen.getByRole("button", { name: "Режим промпта: Агент" })).toBeTruthy();

    // Shift+«Ж» is one capital letter: the key went down as part of something
    // else, and the chat keeps the mode it had.
    fireEvent.keyDown(input, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(input, { key: "Ж", shiftKey: true });
    fireEvent.keyUp(input, { key: "Ж" });
    fireEvent.keyUp(input, { key: "Shift" });
    expect(mode()).toBe("agent");

    // Words in the field take the shortcut away: Shift over a prompt being
    // written is the reader's modifier (a selection, a chord), and the mode
    // under the words must not move on a press meant for them.
    await userEvent.type(input, "переписать парсер");
    shiftTap();
    expect(mode()).toBe("agent");
    expect(input.value).toBe("переписать парсер");
  }, 20_000);

  // The pencil in the queue hands a request's text down to the field. The mode
  // it was written in comes with it: the chip over the words is that request's,
  // and a pick rewrites the request — the chat's own mode never moves.
  it("rewrites a queued request in its own mode", async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru", chatMetaChips: ["promptMode"] },
      promptQueue: [
        {
          id: "q1",
          text: "переписать парсер",
          sessionId: "s1",
          mode: "plan",
          editMessageId: null,
        },
      ],
    } as never);
    const { container } = renderChat();

    const row = container.querySelector('[data-queue-id="q1"]') as HTMLElement;
    await userEvent.click(within(row).getAllByRole("button")[1]!);

    // The field is the request's editor, and it wears the request's mode: the
    // chat itself is still in agent, and nothing was written to it.
    expect(container.querySelector("textarea")!.value).toBe("переписать парсер");
    expect(container.querySelector('[class*="modePill"]')?.textContent).toContain("План");
    expect(localStorage.getItem("acpio.composerModes.v1")).toBeNull();

    // The chip writes the pick back to the request, and the row follows it.
    await userEvent.click(screen.getByRole("button", { name: "Режим промпта: План" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Вопрос" }));
    expect(useAppStore.getState().promptQueue[0]!.mode).toBe("ask");
    expect(localStorage.getItem("acpio.composerModes.v1")).toBeNull();
    expect(row.querySelector('[data-composer-mode="ask"]')?.textContent).toBe("Вопрос");
  }, 20_000);

  it("leaves the mode from the cross in the field's pill", async () => {
    const { container } = renderChat();
    const input = container.querySelector("textarea")!;
    menuOf(input);
    await userEvent.click(screen.getByRole("menuitem", { name: "План" }));
    expect(container.querySelector('[data-composer-mode="plan"]')).toBeTruthy();

    // The pill carries the way back to agent: the mode is the chat's, so one
    // press ends it for everything sent from here on.
    await userEvent.click(screen.getByRole("button", { name: "Вернуться к агенту" }));
    expect(container.querySelector('[data-composer-mode]')).toBeNull();
    expect(localStorage.getItem("acpio.composerModes.v1")).not.toContain('"s1"');
  }, 20_000);

  it("shows a sent message in its mode: the badge, not the skill token", async () => {
    const detail = { ...emptyChat(), messages: [planMessage()] };
    useAppStore.setState({
      sessions: [detail],
      activeSession: detail,
      sessionDetails: { s1: detail },
    } as never);
    renderChat();

    // The prefix is what the agent runs; the reader sees their own words.
    expect(screen.getByText("переписать парсер")).toBeTruthy();
    expect(screen.queryByText(/\/plan/)).toBeNull();
    expect(screen.getAllByText("План").length).toBeGreaterThan(0);
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
    // The git rows are the ones that still write into the field: the command
    // waits there for Enter.
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("commit+push переписать парсер");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  }, 20_000);
});
