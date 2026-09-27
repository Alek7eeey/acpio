// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { SettingsPage } from "./SettingsPage";

const apiMock = vi.hoisted(() => ({
  // Static import is impossible here: vi.mock factories are hoisted above
  // imports, so DEFAULT_SETTINGS is uninitialized at factory runtime.
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
    const { DEFAULT_SETTINGS: defaults } = await import("@acpio/shared");
    return { ...defaults, ...patch };
  }),
  // The MCP leaf polls the live probe status while it is open.
  mcpStatus: vi.fn(async () => ({})),
  // Each provider's models editor fetches its endpoint's /models list.
  builtinModels: vi.fn(async () => ({ ok: true, models: [] })),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

/** The chat leaf renders the row twice (mobile block + "Advanced" details). */
const limitField = () => screen.getAllByLabelText("Chats per folder")[0] as HTMLInputElement;

beforeEach(() => {
  // jsdom has no ResizeObserver; the settings preview and the layout rows use it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: false });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: false });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SettingsPage form state", () => {
  // The store holds DEFAULT_SETTINGS until bootstrap resolves, and a deep link
  // to /settings paints before that — the form must pick the payload up then.
  it("hydrates the form from the settings payload that arrives after mount", async () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=interface&leaf=chat"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(limitField().value).toBe("0");

    act(() => {
      useAppStore.setState({
        settings: { ...DEFAULT_SETTINGS, chatTreeRecentLimit: 7 },
        bootstrapped: true,
      });
    });
    expect(limitField().value).toBe("7");
  });

  // Regression: the guard used to be "the first settings object that differs
  // from the one at mount", so a page mounted after bootstrap hydrated on the
  // first save-echo instead — and that echo carries the pre-save payload, which
  // reverted the switches the user had just set (they came back after a second
  // attempt, once the guard had fired).
  it("keeps the switches the user set when the store echoes a settings snapshot", async () => {
    const user = userEvent.setup();
    const saved = {
      ...DEFAULT_SETTINGS,
      mcpServers: [
        { id: "mcp-a", name: "Alpha", enabled: true, type: "remote" as const, url: "http://a/mcp" },
      ],
    };
    useAppStore.setState({ settings: saved, bootstrapped: true });
    render(
      <MemoryRouter initialEntries={["/settings?section=agent&leaf=mcp"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    const toggle = screen.getByRole("checkbox", { name: "Enabled" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await user.click(toggle);
    expect(toggle.checked).toBe(false);

    // What saveSettings does around a save: a fresh object holding the values
    // from before the edit.
    act(() => {
      useAppStore.setState({ settings: { ...saved, chatSplit: false } });
    });

    expect(toggle.checked).toBe(false);
  });

  // Regression: an unconditional `setForm(settings)` sync reverted the form on
  // every store update. Against a payload that does not carry a field (an API
  // process predating it, or a save response landing out of order) it erased
  // each keystroke of that field back to its default.
  it("keeps what the user typed when a later settings payload omits the field", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/settings?section=interface&leaf=chat"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, chatTreeRecentLimit: 7 },
      bootstrapped: true,
    });
    await waitFor(() => expect(limitField().value).toBe("7"));

    const field = limitField();
    await user.clear(field);
    await user.type(field, "12");
    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith({ chatTreeRecentLimit: 12 }),
    );
    expect(field.value).toBe("12");

    // A payload written before the field existed, echoed back by the store.
    const stale = { ...DEFAULT_SETTINGS } as Partial<AppSettings>;
    delete stale.chatTreeRecentLimit;
    act(() => {
      useAppStore.setState({ settings: stale as AppSettings });
    });

    expect(field.value).toBe("12");
  });
});

describe("Built-in providers", () => {
  const providerA = {
    id: "p1",
    name: "Ollama",
    url: "http://localhost:11434/v1",
    apiKey: "",
    models: [{ id: "qwen", label: "Qwen", contextWindow: 32_000 }],
  };
  const providerB = {
    id: "p2",
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    apiKey: "sk-x",
    models: [],
  };

  it("edits, adds and removes providers and saves them as one list", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, builtinProviders: [providerA, providerB] },
      bootstrapped: true,
    });
    render(
      <MemoryRouter initialEntries={["/settings?section=agent&leaf=builtin"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    // Every field carries its provider's name, so the rows never collide.
    const urlA = screen.getByLabelText("Ollama · Endpoint") as HTMLInputElement;
    const urlB = screen.getByLabelText("OpenRouter · Endpoint") as HTMLInputElement;
    expect(urlA.value).toBe("http://localhost:11434/v1");
    expect(urlB.value).toBe("https://openrouter.ai/api/v1");
    expect(screen.getByDisplayValue("Qwen")).toBeTruthy();

    await user.clear(urlA);
    await user.type(urlA, "http://localhost:11434/v2");

    await user.click(screen.getByRole("button", { name: /\+ Add provider/ }));
    expect(screen.getByLabelText("Unnamed provider 3 · Provider name")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete · OpenRouter" }));
    expect(screen.queryByLabelText("OpenRouter · Endpoint")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSettings).toHaveBeenCalled());
    const patch = apiMock.updateSettings.mock.calls.at(-1)?.[0] as {
      builtinProviders?: Array<{ id: string; name: string; url: string; models: unknown[] }>;
    };
    const rows = patch.builtinProviders ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "p1", name: "Ollama", url: "http://localhost:11434/v2" });
    expect(rows[0]?.models).toEqual(providerA.models);
    expect(rows[1]).toMatchObject({ id: expect.any(String), name: "", url: "" });
  });
});
