// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
