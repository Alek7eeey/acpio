// @vitest-environment jsdom
// A message the reader rewrote is one bubble with a quiet mark — not a second
// message beside the old one. The mark comes from the message itself (the server
// stores when it was edited), so a reload and every tab read it the same way.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
if (!("scrollIntoView" in Element.prototype)) {
  Element.prototype.scrollIntoView = () => {};
}

function userMessage(
  id: string,
  text: string,
  editedAt?: string,
): SessionDetailDto["messages"][number] {
  const part: MessagePartDto = {
    id: `${id}-text`,
    messageId: id,
    type: "text",
    order: 0,
    payload: { text },
    createdAt: "2026-10-01T10:00:00.000Z",
  };
  return {
    id,
    sessionId: "s1",
    role: "user",
    createdAt: "2026-10-01T10:00:00.000Z",
    ...(editedAt ? { editedAt } : {}),
    parts: [part],
  };
}

const detail: SessionDetailDto = {
  id: "s1",
  title: "Edited message",
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
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:05.000Z",
  lastMessageAt: "2026-10-01T10:00:05.000Z",
  messages: [
    userMessage("u1", "обычный вопрос"),
    userMessage("u2", "переписанный вопрос", "2026-10-01T10:00:04.000Z"),
  ],
};

beforeEach(() => {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const },
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

describe("the mark on a rewritten message", () => {
  it("sits on the edited bubble only", async () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    const marks = await screen.findAllByText("изменено");
    expect(marks).toHaveLength(1);
    const row = marks[0]!.closest(`.${styles.userMsg}`);
    expect(row?.textContent).toContain("переписанный вопрос");
    // The message sent once and never rewritten carries no mark.
    expect(row?.textContent).not.toContain("обычный вопрос");
  });
});
