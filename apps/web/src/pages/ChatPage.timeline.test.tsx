// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type MessagePartDto, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";
import styles from "./ChatPage.module.css";

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

// jsdom ships no scrollIntoView; the question prompt keeps its active option in view.
if (!("scrollIntoView" in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

function part(id: string, type: MessagePartDto["type"], order: number, text: string): MessagePartDto {
  return {
    id,
    messageId: "m1",
    type,
    order,
    payload: { text },
    createdAt: "2026-09-30T10:00:02.000Z",
  };
}

/** A finished turn with two reasoning phases — the shape the reader scrolls
 *  through when the transcript is expanded after the agent stopped. */
const detail: SessionDetailDto = {
  id: "s1",
  title: "Two phases",
  provider: "omp",
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
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:00:03.000Z",
  lastMessageAt: "2026-09-30T10:00:03.000Z",
  messages: [
    { id: "u1", sessionId: "s1", role: "user", createdAt: "2026-09-30T10:00:00.000Z", parts: [] },
    {
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      createdAt: "2026-09-30T10:00:01.000Z",
      parts: [
        part("t1", "thought", 0, "Сначала посмотрю файлы"),
        part("x1", "text", 1, "Проверил папку"),
        part("t2", "thought", 2, "Теперь читаю файлы"),
        part("x2", "text", 3, "Готово: два файла"),
      ],
    },
  ],
};

beforeEach(() => {
  localStorage.setItem("acpio.autoExpandSteps.v3", "1");
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatAgentTurnTimeline: true },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    sessionDetails: { s1: detail },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("finished turn reasoning headers", () => {
  // The reader who scrolled past a reasoning phase could only fold it from the
  // collapsed spoiler header — reachable only by scrolling back. Every open
  // phase inside the body pins its own header now.
  it("pins every phase header inside the expanded transcript", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    await screen.findAllByText(/Сначала посмотрю файлы|Теперь читаю файлы/);

    const spoilerHeader = container.querySelector<HTMLElement>(`.${styles.steps} > .${styles.stepsToggle}`);
    expect(spoilerHeader).toBeTruthy();

    const pinnedRuns = container.querySelectorAll(
      `.${styles.stepsBody} .${styles.stepsToggle}${`.${styles.stepsToggleSticky}`}`,
    );
    expect(pinnedRuns.length).toBe(2);
  });
});

describe("parked question", () => {
  // The reported layout: the model narrates, asks, and parks on the reader.
  // The turn must read as finished — one run block above, then the lead-in
  // joined to the card — instead of grey narration under a fresh run header
  // that claims work is still going on.
  const rawQuestions = [
    { id: "place", question: "Где разместить блок?", options: [{ label: "Интерфейс" }] },
  ];
  const uiQuestions = [
    { id: "place", prompt: "Где разместить блок?", options: [{ id: "opt0", label: "Интерфейс" }] },
  ];
  const leadIn = "Посмотрел, как это устроено. Коротко по фактам:";
  const asked: SessionDetailDto = {
    ...detail,
    status: "waiting",
    messages: [
      detail.messages[0]!,
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        createdAt: "2026-09-30T10:00:01.000Z",
        parts: [
          {
            id: "t1",
            messageId: "m1",
            type: "thought",
            order: 0,
            payload: { text: "Сначала посмотрю настройки" },
            createdAt: "2026-09-30T10:00:01.000Z",
          },
          {
            id: "x1",
            messageId: "m1",
            type: "text",
            order: 1,
            payload: { text: leadIn },
            createdAt: "2026-09-30T10:00:01.000Z",
          },
          // The ask row is recorded between the lead-in and the question.
          {
            id: "a1",
            messageId: "m1",
            type: "tool_call",
            order: 2,
            payload: {
              toolCallId: "call_ask",
              title: "ask",
              status: "cancelled",
              raw: { rawInput: { questions: rawQuestions } },
            },
            createdAt: "2026-09-30T10:00:01.000Z",
          },
          {
            id: "q1",
            messageId: "m1",
            type: "question",
            order: 3,
            payload: {
              requestId: "req1",
              pending: true,
              title: "Где разместить блок?",
              questions: uiQuestions,
            },
            createdAt: "2026-09-30T10:00:01.000Z",
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    useAppStore.setState({
      // No meta chips: the mocked api answers git calls with `{}`, and the git
      // chip reads `status.files` off it.
      settings: {
        ...DEFAULT_SETTINGS,
        locale: "ru" as const,
        chatAgentTurnTimeline: true,
        chatMetaChips: [],
      },
      sessions: [asked],
      activeSessionId: "s1",
      activeSession: asked,
      sessionLoading: false,
      error: null,
      chatPaneIds: ["s1"],
      focusedPaneIndex: 0,
      unseenFinishedTurns: {},
      sessionDetails: { s1: asked },
    });
  });

  it("shows the model as finished: one run block, then the lead-in with the card", async () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    // The prompt hangs as its own block, still waiting for the reader.
    expect(container.querySelector("[data-question-prompt]")).toBeTruthy();
    expect(container.textContent).toContain("Ожидание ввода");

    // One block of finished work above the card — the ask call rides into it
    // instead of opening a second one right over the prompt.
    const runHeaders = container.querySelectorAll(
      `.${styles.agentTimeline} .${styles.stepsToggle}`,
    );
    expect(runHeaders).toHaveLength(1);

    // The lead-in travels with the question, not as loose narration in the
    // timeline above it.
    const lead = screen.getByText(leadIn);
    expect(lead.closest(`.${styles.questionBucket}`)).toBeTruthy();

    // Nothing on screen claims the agent is still generating.
    expect(container.textContent).not.toContain("Работаю");
  });
});

describe("compaction row", () => {
  /** The turn that ran the squeeze: the row, then the work it was folded for. */
  const compacted: SessionDetailDto = {
    ...detail,
    messages: [
      detail.messages[0]!,
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        createdAt: "2026-09-30T10:00:01.000Z",
        parts: [
          {
            id: "c1",
            messageId: "m1",
            type: "compaction",
            order: 0,
            payload: {
              manual: false,
              coveredBefore: 0,
              coveredAfter: 6,
              tokensBefore: 9_000,
              tokensAfter: 2_500,
              summary: "Задача: починить парсер\nСделано: тесты",
            },
            createdAt: "2026-09-30T10:00:01.000Z",
          },
          // Two phases, so the turn really does fold into a "Работал" spoiler:
          // a row asserted outside a spoiler that never rendered proves nothing.
          part("t1", "thought", 1, "Сначала посмотрю файлы"),
          part("x1", "text", 2, "Проверил папку"),
          part("t2", "thought", 3, "Теперь читаю файлы"),
          part("x2", "text", 4, "Готово: два файла"),
        ],
      },
    ],
  };

  beforeEach(() => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatAgentTurnTimeline: true },
      sessions: [compacted],
      activeSessionId: "s1",
      activeSession: compacted,
      sessionLoading: false,
      error: null,
      chatPaneIds: ["s1"],
      focusedPaneIndex: 0,
      unseenFinishedTurns: {},
      sessionDetails: { s1: compacted },
    });
  });

  const renderThread = () =>
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );

  it("stands on the surface of the thread: sizes, turns and the digest behind the toggle", async () => {
    const { container } = renderThread();
    await screen.findByText("Контекст сжат");

    // The turn itself is folded, as always — and the squeeze is not inside it.
    const spoiler = container.querySelector<HTMLElement>(`.${styles.steps}`);
    expect(spoiler).toBeTruthy();
    expect(spoiler?.textContent).toContain("Сначала посмотрю файлы");

    const row = container.querySelector<HTMLElement>("[data-compaction-id]");
    expect(row).toBeTruthy();
    expect(row?.closest(`.${styles.steps}`)).toBeNull();
    expect(row?.closest(`.${styles.stepsBody}`)).toBeNull();

    expect(row?.textContent).toContain("ходы 1–6");
    expect(row?.textContent).toContain("9k → 2.5k токенов");
    expect(row?.textContent).toContain("показать конспект");
    expect(container.textContent).not.toContain("починить парсер");

    // The digest itself is what the row is for — readable back, not a footnote.
    await userEvent.click(screen.getByRole("button", { name: "показать конспект" }));
    expect(container.textContent).toContain("починить парсер");
    expect(screen.getByRole("button", { name: "скрыть конспект" })).toBeTruthy();
  });
});
