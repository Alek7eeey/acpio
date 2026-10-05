// @vitest-environment jsdom
//
// Regression: the composer's model-params prefetch used to re-run every render
// while the chat's provider had no models catalog. `loadParamsForModel` closed
// over `catalog?.models ?? []` / `catalog?.modes ?? []` — fresh arrays whenever
// the catalog was missing — so its useCallback identity changed on every render,
// the `[.., loadParamsForModel]` effect re-fired, and each pass issued another
// `/api/agent/model-params` request. The built-in provider surfaces this hardest
// because it exposes no params, so nothing gets cached to break the cycle.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type SessionDetailDto } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ChatPage } from "./ChatPage";

const apiMock = vi.hoisted(() => ({
  getModelParams: vi.fn(async () => ({ ok: true, modelParams: [] })),
}));

vi.mock("../lib/api", () => {
  const target: Record<string, unknown> = { getModelParams: apiMock.getModelParams };
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

/** Built-in chat pinned to a composite model, with no catalog loaded. */
const detail: SessionDetailDto = {
  id: "b1",
  title: "чат_тест_buildIn",
  provider: "builtin",
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
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:05.000Z",
  lastMessageAt: "2026-10-01T09:00:05.000Z",
  model: "p1::m1",
  messages: [],
};

beforeEach(() => {
  useAppStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      locale: "ru" as const,
      builtinProviders: [
        {
          id: "p1",
          name: "Provider",
          url: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
        },
      ],
    },
    sessions: [detail],
    activeSessionId: "b1",
    activeSession: detail,
    sessionDetails: { b1: detail },
    sessionLoading: false,
    error: null,
    chatPaneIds: ["b1"],
    focusedPaneIndex: 0,
    unseenFinishedTurns: {},
    modelsCatalog: null,
    modelsLoading: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("composer model-params prefetch", () => {
  it("requests params once when the provider has no catalog, instead of per render", async () => {
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <I18nProvider>
          <ChatPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    setTimeout(settle, 120);
    await settled;

    expect(apiMock.getModelParams).toHaveBeenCalledWith(
      "builtin",
      "p1::m1",
      expect.anything(),
    );
    // `<= 1` fails loudly if the effect loop returns: each render used to fire a
    // fresh request (hundreds within this window).
    expect(apiMock.getModelParams.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
