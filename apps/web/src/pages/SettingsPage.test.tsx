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
  // The search query lives in the store: leaving it set would open the next
  // test on the result list instead of the leaf it deep-links to.
  useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: false, settingsQuery: "" });
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

  // Regression: the path-list textareas normalized on every keystroke (split,
  // trim, drop-blank, join), so the blank line Enter had just created vanished
  // under the caret — a second path could not be typed on a new line at all.
  it("keeps the line break Enter creates in the skill-folders textarea", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: true });
    render(
      <MemoryRouter initialEntries={["/settings?section=agent&leaf=builtin"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    const field = screen.getByLabelText("Skill folders") as HTMLTextAreaElement;
    expect(field.value).toBe(".agents/skills\n~/.agents/skills");

    // Still focused: the draft must hold the fresh empty line.
    await user.type(field, "{Enter}");
    expect(field.value).toBe(".agents/skills\n~/.agents/skills\n");

    await user.type(field, "~/x/skills");
    expect(field.value).toBe(".agents/skills\n~/.agents/skills\n~/x/skills");

    // Left the field: the canonical one-path-per-line form is back.
    await user.tab();
    expect(field.value).toBe(".agents/skills\n~/.agents/skills\n~/x/skills");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.updateSettings).toHaveBeenCalled());
    const saved = apiMock.updateSettings.mock.calls.at(-1)?.[0] as {
      builtinSkillPaths?: string[];
    };
    expect(saved.builtinSkillPaths).toEqual([
      ".agents/skills",
      "~/.agents/skills",
      "~/x/skills",
    ]);
  });

  // The switch is what lets the agent open a skill folder outside the chat
  // folder, so it applies at once instead of waiting for the Save button.
  it("saves the outside-the-folder switch as soon as it is flipped", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: true });
    render(
      <MemoryRouter initialEntries={["/settings?section=agent&leaf=builtin"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    const toggle = screen.getByLabelText("Work outside the working folder") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await user.click(toggle);
    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith({ builtinAllowOutsideCwd: true }),
    );
    expect(toggle.checked).toBe(true);
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

  /** Provider cards are `<details>` (the CSS-module class suffix is hashed). */
  const providerCards = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll("details[class*=providerCard]"),
    ) as HTMLDetailsElement[];
  const cardSummary = (card: HTMLDetailsElement) =>
    card.querySelector("summary") as HTMLElement;

  const renderProviders = () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, builtinProviders: [providerA, providerB] },
      bootstrapped: true,
    });
    return render(
      <MemoryRouter initialEntries={["/settings?section=agent&leaf=builtin"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );
  };

  it("edits, adds and removes providers and saves them as one list", async () => {
    const user = userEvent.setup();
    const { container } = renderProviders();
    // The endpoint of the provider being edited lives under its folded header.
    await user.click(cardSummary(providerCards(container)[0]!));

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

  // The leaf used to paint the name, endpoint, key, headers and model rows of
  // every provider at once — a couple of providers buried the rest of the
  // section. The list stays scannable only while the cards are shut.
  it("keeps each provider folded until its header is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderProviders();

    const cards = providerCards(container);
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => !card.hasAttribute("open"))).toBe(true);

    // The header alone tells the providers apart.
    expect(cardSummary(cards[0]!).textContent).toContain("Ollama");
    expect(cardSummary(cards[0]!).textContent).toContain("http://localhost:11434/v1");
    expect(cardSummary(cards[1]!).textContent).toContain("OpenRouter");

    await user.click(cardSummary(cards[0]!));
    expect(cards[0]!.hasAttribute("open")).toBe(true);
    await user.click(cardSummary(cards[0]!));
    expect(cards[0]!.hasAttribute("open")).toBe(false);
  });

  it("unfolds the card of a provider the user just added", async () => {
    const user = userEvent.setup();
    const { container } = renderProviders();

    await user.click(screen.getByRole("button", { name: /\+ Add provider/ }));

    const cards = providerCards(container);
    expect(cards).toHaveLength(3);
    expect(cards[2]!.hasAttribute("open")).toBe(true);
  });

  // A search hunts for single rows, which live inside the folded cards: the
  // hits must be on screen when the leaf is opened from the result list.
  it("unfolds the cards while a search is running", async () => {
    const user = userEvent.setup();
    const { container } = renderProviders();

    await user.type(screen.getAllByLabelText("Search settings…")[0]!, "providers");
    const hit = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("Built-in agent"));
    expect(hit).toBeTruthy();
    await user.click(hit!);

    const cards = providerCards(container);
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.hasAttribute("open"))).toBe(true);
  });
});

describe("SettingsPage board leaf", () => {
  // The board options live on their own "Доска"/"Board" leaf, not squeezed
  // into Appearance: the deep link must render the picker, ready to change.
  it("renders the add-task placeholder picker under section=interface&leaf=board", async () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=interface&leaf=board"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Board settings")).toBeTruthy();
    expect(screen.getByText("Board “Add task” placeholder")).toBeTruthy();
  });

  it("keeps the placeholder row off the Appearance leaf", async () => {
    render(
      <MemoryRouter initialEntries={["/settings?section=interface&leaf=appearance"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByText("Board “Add task” placeholder")).toBeNull();
  });
});

describe("Chat title from a model", () => {
  const provider = {
    id: "p1",
    name: "Ollama",
    url: "http://localhost:11434/v1",
    apiKey: "",
    models: [{ id: "qwen", label: "Qwen", contextWindow: 32_000 }],
  };

  const renderChatLeaf = () =>
    render(
      <MemoryRouter initialEntries={["/settings?section=interface&leaf=chat"]}>
        <I18nProvider>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>,
    );

  it("locks the switch and says why while the built-in agent is unconfigured", async () => {
    useAppStore.setState({ settings: DEFAULT_SETTINGS, bootstrapped: true });
    renderChatLeaf();

    const toggle = screen.getByLabelText("Refine the title with a model") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    // The stored default is on, but with no endpoint it must read as off —
    // a checked switch that can never fire would promise a feature that isn't there.
    expect(toggle.checked).toBe(false);
    expect(
      screen.getByText(/The built-in agent is not configured/),
    ).toBeTruthy();
    expect(screen.getByText("Open built-in agent settings")).toBeTruthy();
  });

  it("unlocks the switch once a provider with a model exists", async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, builtinProviders: [provider] },
      bootstrapped: true,
    });
    renderChatLeaf();

    const toggle = screen.getByLabelText("Refine the title with a model") as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    // Default on: a configured built-in agent gets model titles without a click.
    expect(toggle.checked).toBe(true);
    expect(screen.queryByText(/The built-in agent is not configured/)).toBeNull();
  });

  it("stays locked when a provider has an endpoint but no model to write titles", async () => {
    useAppStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        builtinProviders: [{ ...provider, models: [] }],
      },
      bootstrapped: true,
    });
    renderChatLeaf();

    const toggle = screen.getByLabelText("Refine the title with a model") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/The built-in agent is not configured/)).toBeTruthy();
  });

  it("saves the switch with the chat leaf's Save", async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, builtinProviders: [provider], chatAutoTitle: false },
      bootstrapped: true,
    });
    renderChatLeaf();

    const toggle = screen.getByLabelText("Refine the title with a model") as HTMLInputElement;
    await user.click(toggle);
    expect(toggle.checked).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiMock.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ chatAutoTitle: true }),
      ),
    );
  });
});
