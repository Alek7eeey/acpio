// @vitest-environment jsdom
//
// The plan's approval, end to end as the reader's click drives it: the card
// above the input answers the parked turn, the panel's own button starts a turn
// nobody was parked on — with a prompt the chat never shows — and a rejection
// implements nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type MessageDto, type SessionDetailDto } from "@acpio/shared";
import { api } from "../lib/api";
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

/** The plan's own payload: a file with a stage and a pace, as the agent writes it. */
const PLAN_PAYLOAD = {
  name: "План как файл",
  overview: "План переезжает в файл.",
  stage: "draft",
  pacing: "whole",
  path: ".acpio/plan.md",
  todos: [
    { id: "e0", content: "Написать planFile.ts", status: "pending" },
    { id: "e1", content: "Тесты на parse", status: "pending" },
  ],
};

/** The turn that published the plan: the part is what the panel draws. */
const planMessage: MessageDto = {
  id: "m1",
  sessionId: "s1",
  role: "assistant",
  createdAt: "2026-09-30T10:00:01.000Z",
  parts: [
    {
      id: "p1",
      messageId: "m1",
      type: "text",
      order: 0,
      payload: { text: "Вот план — он в панели справа." },
      createdAt: "2026-09-30T10:00:01.000Z",
    },
    {
      id: "p2",
      messageId: "m1",
      type: "plan",
      order: 1,
      payload: PLAN_PAYLOAD,
      createdAt: "2026-09-30T10:00:01.000Z",
    },
  ],
};

function session(overrides: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return {
    id: "s1",
    title: "План как файл",
    // A harness the store does not demand an endpoint for: the send path below
    // must reach the api, not bounce off a configuration warning.
    provider: "omp",
    cwd: "E:/proj",
    mode: "agent",
    status: "waiting",
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
    updatedAt: "2026-09-30T10:00:01.000Z",
    lastMessageAt: "2026-09-30T10:00:01.000Z",
    messages: [planMessage],
    ...overrides,
  };
}

function park(detail: SessionDetailDto, pending: boolean) {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatMetaChips: [] },
    sessions: [detail],
    activeSessionId: "s1",
    activeSession: detail,
    sessionLoading: false,
    error: null,
    chatPaneIds: ["s1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    sessionDetails: { s1: detail },
    consoleOpen: false,
    gitPanelOpen: false,
    pendingQuestion: pending
      ? {
          sessionId: "s1",
          requestId: "r1",
          kind: "create_plan",
          payload: PLAN_PAYLOAD,
        }
      : null,
  });
}

/** The agent publishes the plan mid-chat: that is what opens the panel. A plan
 *  already on screen when the page mounts leaves the panel as the reader left it. */
function publishPlan() {
  const withPlan = session({ status: "idle" });
  act(() => {
    useAppStore.setState({
      sessions: [withPlan],
      activeSession: withPlan,
      sessionDetails: { s1: withPlan },
    });
  });
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/chat"]}>
      <I18nProvider>
        <ChatPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // A wide viewport: the panel docks beside the chat instead of taking it over.
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ pendingQuestion: null });
  vi.clearAllMocks();
});

describe("the plan's approval", () => {
  it("turns the card's approve into the plan's stage and the parked turn's answer", async () => {
    park(session(), true);
    renderChat();

    // The pace is asked first: nothing starts until the reader says how.
    fireEvent.click(await screen.findByText("Одобрить"));
    expect(api.setSessionPlan).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByText("По одному"));

    await waitFor(() =>
      expect(api.setSessionPlan).toHaveBeenCalledWith("s1", {
        stage: "applying",
        pacing: "step",
      }),
    );
    // The parked `apply_plan` goes on with the plan — no second prompt, and
    // nothing typed on the reader's behalf.
    expect(api.answerQuestion).toHaveBeenCalledWith("s1", "r1", {
      outcome: { outcome: "accepted" },
    });
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("starts a draft nobody waits on with a prompt the chat never shows", async () => {
    park(session({ status: "idle", messages: [] }), false);
    renderChat();
    publishPlan();

    fireEvent.click(await screen.findByText("Утвердить и начать"));

    await waitFor(() =>
      expect(api.setSessionPlan).toHaveBeenCalledWith("s1", {
        stage: "applying",
        pacing: "whole",
      }),
    );
    await waitFor(() => expect(api.prompt).toHaveBeenCalled());
    expect(api.prompt).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("План утверждён"),
      { internal: true },
    );
    expect(api.answerQuestion).not.toHaveBeenCalled();
  });

  it("closes the card with no answer clicked: the parked turn ends, nothing starts", async () => {
    park(session(), true);
    renderChat();

    fireEvent.click(await screen.findByLabelText("Закрыть карточку и написать новый запрос"));

    // A parked turn only ends by being answered — silence is not consent.
    await waitFor(() =>
      expect(api.answerQuestion).toHaveBeenCalledWith("s1", "r1", {
        outcome: { outcome: "rejected", reason: "rejected by user" },
      }),
    );
    expect(api.setSessionPlan).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("answers a rejection and sends nothing else: the plan stays a draft", async () => {
    park(session(), true);
    renderChat();

    fireEvent.click(await screen.findByText("Отклонить"));

    await waitFor(() =>
      expect(api.answerQuestion).toHaveBeenCalledWith("s1", "r1", {
        outcome: { outcome: "rejected", reason: "rejected by user" },
      }),
    );
    expect(api.setSessionPlan).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("does not offer the same approval twice while it is on its way", async () => {
    park(session({ status: "idle", messages: [] }), false);
    renderChat();
    publishPlan();

    const approve = (await screen.findByText("Утвердить и начать")).closest("button");
    fireEvent.click(approve!);

    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(approve!);
    expect(api.setSessionPlan).toHaveBeenCalledTimes(1);
    // The pace switch stays: the reader paces the work already running.
    expect(screen.getByText("По одному")).toBeTruthy();
  });
});
