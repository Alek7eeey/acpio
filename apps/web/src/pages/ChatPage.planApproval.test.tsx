// @vitest-environment jsdom
//
// The plan's approval, end to end as the reader's click drives it: the card
// above the input answers the parked turn, the panel's own button starts a turn
// nobody was parked on — with a prompt the chat never shows — and a rejection
// implements nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("finds the parked plan again when the chat is opened after the fact", async () => {
    // The board draws «Ожидание ввода» from the session row; a chat opened
    // later gets no live `question.request`, so the card has to come from the
    // plan part that asks it. Without that the chat shows a finished turn, no
    // card, and nothing the reader can answer.
    const parked = session({
      messages: [
        {
          ...planMessage,
          parts: [
            planMessage.parts[0]!,
            {
              ...planMessage.parts[1]!,
              payload: { ...PLAN_PAYLOAD, requestId: "s1:237", pending: true },
            },
          ],
        },
      ],
    });
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatMetaChips: [] },
      sessions: [parked],
      activeSessionId: null,
      activeSession: null,
      sessionLoading: true,
      sessionDetails: {},
      chatPaneIds: [],
      focusedPaneIndex: 0,
      pendingQuestion: null,
    });
    vi.mocked(api.getSession).mockResolvedValue(parked);

    await act(() => useAppStore.getState().selectSession("s1"));
    expect(useAppStore.getState().pendingQuestion).toMatchObject({
      sessionId: "s1",
      requestId: "s1:237",
      kind: "create_plan",
    });

    // The other door to the same snapshot: the chat is already open in the tab
    // (a board card clicked on top of it), so the refresh runs down the warm
    // path — and that one has to find the parked plan too.
    useAppStore.setState({ pendingQuestion: null });
    await act(() => useAppStore.getState().selectSession("s1"));
    expect(useAppStore.getState().pendingQuestion).toMatchObject({
      requestId: "s1:237",
      kind: "create_plan",
    });

    renderChat();
    fireEvent.click((await planCard()).getByText("Отклонить"));
    await waitFor(() =>
      expect(api.answerQuestion).toHaveBeenCalledWith("s1", "s1:237", {
        outcome: { outcome: "rejected", reason: "rejected by user" },
      }),
    );
  });

  /** The card above the input. The panel's footer repeats its answers once the
   *  panel is open, so the card's own clicks are scoped to it. */
  async function planCard() {
    return within(await screen.findByRole("group", { name: "План" }));
  }

  /** A chat whose newest plan part may or may not be waiting for an answer. Its
   *  own id: the store caches a detail per session, and a second chat built on
   *  the first one's id would come back from that cache. */
  function planSession(id: string, pending: boolean): SessionDetailDto {
    return session({
      id,
      messages: [
        {
          ...planMessage,
          parts: [
            planMessage.parts[0]!,
            {
              ...planMessage.parts[1]!,
              payload: pending
                ? { ...PLAN_PAYLOAD, requestId: `${id}:237`, pending: true }
                : PLAN_PAYLOAD,
            },
          ],
        },
      ],
    });
  }

  /** Open a chat the way the app does on a reload: nothing on screen, then the
   *  detail lands — its parked question with it. */
  async function openChat(detail: SessionDetailDto) {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, locale: "ru" as const, chatMetaChips: [] },
      sessions: [detail],
      activeSessionId: null,
      activeSession: null,
      sessionLoading: true,
      sessionDetails: {},
      chatPaneIds: [],
      focusedPaneIndex: 0,
      pendingQuestion: null,
    });
    vi.mocked(api.getSession).mockResolvedValue(detail);
    await act(() => useAppStore.getState().selectSession(detail.id));
    return renderChat();
  }

  it("opens the panel on a chat reopened while its plan waits for an approval", async () => {
    // A plan nobody waits on is not news: reopening its chat keeps the layout
    // the reader left it with.
    await openChat(planSession("s7", false));
    expect(screen.queryByLabelText("Редактировать план")).toBeNull();
    cleanup();

    // The same chat, its plan now parked on `apply_plan`: the card above the
    // input asks about that plan, so the panel drawing it comes back too.
    await openChat(planSession("s8", true));
    expect(await screen.findByLabelText("Редактировать план")).toBeTruthy();
  });

  it("opens the panel when a plan is composed, and only then — not on every step", async () => {
    const withPlan = (name: string, status: string, stage = "draft"): SessionDetailDto => ({
      ...session({ status: "idle" }),
      messages: [
        {
          ...planMessage,
          parts: [
            planMessage.parts[0]!,
            {
              ...planMessage.parts[1]!,
              payload: {
                ...PLAN_PAYLOAD,
                name,
                stage,
                todos: [
                  { id: "e0", content: "Написать planFile.ts", status },
                  { id: "e1", content: "Тесты на parse", status: "pending" },
                ],
              },
            },
          ],
        },
      ],
    });
    park(session({ status: "idle", messages: [] }), false);
    renderChat();

    // The plan arrives mid-chat: the panel takes over and shows it.
    const first = withPlan("План как файл", "pending");
    act(() => useAppStore.setState({ activeSession: first, sessionDetails: { s1: first } }));
    expect(await screen.findByLabelText("Редактировать план")).toBeTruthy();

    // The reader closes it — and neither a closed step nor the stage flipping to
    // implementing brings it back: that is the same plan, already read.
    fireEvent.click(screen.getByLabelText("Отмена"));
    expect(screen.queryByLabelText("Редактировать план")).toBeNull();
    const stepped = withPlan("План как файл", "completed", "applying");
    act(() => useAppStore.setState({ activeSession: stepped, sessionDetails: { s1: stepped } }));
    expect(screen.queryByLabelText("Редактировать план")).toBeNull();

    // Another plan is news: it opens again.
    const next = withPlan("Другой план", "pending");
    act(() => useAppStore.setState({ activeSession: next, sessionDetails: { s1: next } }));
    expect(await screen.findByLabelText("Редактировать план")).toBeTruthy();
  });

  it("draws the plan the reader just saved by hand: nobody is left to republish it", async () => {
    park(session({ status: "idle", messages: [] }), false);
    vi.mocked(api.getSessionPlan).mockResolvedValue({
      ok: true,
      text: "---\nstage: draft\n---\n",
    });
    vi.mocked(api.setSessionPlan).mockResolvedValue({
      ok: true,
      plan: {
        ...PLAN_PAYLOAD,
        overview: "Правка руками",
      },
    });
    renderChat();
    publishPlan();

    fireEvent.click(await screen.findByLabelText("Редактировать план"));
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "---\nstage: draft\n---\n" },
    });
    expect(screen.queryByText("Правка руками")).toBeNull();
    fireEvent.click(screen.getByText("Сохранить"));

    await waitFor(() => expect(screen.getByText("Правка руками")).toBeTruthy());
  });

  it("turns the card's approve into the plan's stage and the parked turn's answer", async () => {
    park(session(), true);
    renderChat();

    // The pace is asked first: nothing starts until the reader says how.
    fireEvent.click(await screen.findByText("Одобрить"));
    expect(api.setSessionPlan).not.toHaveBeenCalled();
    // The popup, not the panel's own pace switch: that one is on screen too.
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Как выполнять шаги?" })).getByText(
        "По одному",
      ),
    );

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

    fireEvent.click(await screen.findByText("Утвердить"));

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

    fireEvent.click((await planCard()).getByText("Отклонить"));

    await waitFor(() =>
      expect(api.answerQuestion).toHaveBeenCalledWith("s1", "r1", {
        outcome: { outcome: "rejected", reason: "rejected by user" },
      }),
    );
    expect(api.setSessionPlan).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("stays closed once the reader closes it: the same parked question is not news", async () => {
    park(session(), true);
    renderChat();

    // The panel came with the parked plan, and the reader closes it by hand.
    expect(await screen.findByLabelText("Редактировать план")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Отмена"));
    expect(screen.queryByLabelText("Редактировать план")).toBeNull();

    // A fresh detail of the same chat flows in: the approval is the same one,
    // so it must not reopen what the reader just closed.
    const refreshed = session();
    act(() =>
      useAppStore.setState({ activeSession: refreshed, sessionDetails: { s1: refreshed } }),
    );
    expect(screen.queryByLabelText("Редактировать план")).toBeNull();
  });

  it("does not offer the same approval twice while it is on its way", async () => {
    park(session({ status: "idle", messages: [] }), false);
    renderChat();
    publishPlan();

    const approve = (await screen.findByText("Утвердить")).closest("button");
    fireEvent.click(approve!);

    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(approve!);
    expect(api.setSessionPlan).toHaveBeenCalledTimes(1);
    // The pace switch stays: the reader paces the work already running.
    expect(screen.getByText("По одному")).toBeTruthy();
  });
});
