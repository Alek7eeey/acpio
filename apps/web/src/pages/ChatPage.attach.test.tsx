// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";
import styles from "./ChatPage.module.css";

const apiMock = vi.hoisted(() => ({
  uploadAttachment: vi.fn(async () => ({ name: "screenshot.png", path: "/tmp/screenshot.png", size: 4 })),
}));

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = {
    uploadAttachment: apiMock.uploadAttachment,
    // A running turn pulls the git chip in; an empty `{}` from the generic
    // proxy would leave `status.files` undefined and crash the chip row.
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

/** A chat whose agent is mid-turn — the composer shows Stop, not Send. */
function runningSession(): SessionDetailDto {
  return {
    id: "s1",
    title: "Working",
    provider: "omp",
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
    startedAt: "2026-10-01T09:00:00.000Z",
    doneAt: null,
    mcpDisabledIds: [],
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:05.000Z",
    lastMessageAt: "2026-10-01T09:00:05.000Z",
    messages: [
      { id: "u1", sessionId: "s1", role: "user", createdAt: "2026-10-01T09:00:00.000Z", parts: [] },
    ],
  };
}

function pasteImage(textarea: HTMLElement) {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", {
    type: "image/png",
  });
  fireEvent.paste(textarea, { clipboardData: { files: [file], items: [] } });
  return file;
}

beforeEach(() => {
  const detail = runningSession();
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
  vi.clearAllMocks();
  localStorage.clear();
});

function renderComposer() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("composer attachments during a running turn", () => {
  // Regression: the paperclip was disabled while the agent worked, so a file
  // could not be staged for the next message — and a pasted screenshot was
  // dropped without a word.
  it("keeps the paperclip live and stages a pasted image", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");

    const attach = container.querySelector<HTMLButtonElement>(`.${styles.attachBtn}`)!;
    expect(attach).toBeTruthy();
    expect(attach.disabled).toBe(false);

    pasteImage(textarea);

    expect(await screen.findByText("screenshot.png")).toBeTruthy();
    expect(apiMock.uploadAttachment).toHaveBeenCalledWith("s1", expect.any(File), "screenshot.png");
  });

  // The staged file must wait for the next prompt: while a turn runs the send
  // button is the stop button, so nothing can leave with the running turn.
  it("offers no send button to push a staged file into the running turn", async () => {
    const { container } = renderComposer();
    const textarea = container.querySelector("textarea")!;
    await screen.findByLabelText("Остановить");

    pasteImage(textarea);
    expect(await screen.findByText("screenshot.png")).toBeTruthy();

    expect(screen.queryByLabelText("Отправить")).toBeNull();
    expect(screen.getByLabelText("Остановить")).toBeTruthy();
  });
});
