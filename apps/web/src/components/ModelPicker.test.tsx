// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { ModelPicker } from "./ModelPicker";

const models = [
  { value: "gpt-4o", name: "GPT-4o Fast" },
  { value: "claude", name: "Claude Sonnet" },
  { value: "deepseek", name: "DeepSeek R1" },
];

function renderPicker(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <I18nProvider>
      <ModelPicker model="gpt-4o" models={models} onChange={onChange} {...props} />
    </I18nProvider>,
  );
  return { onChange, ...view };
}

beforeEach(() => {
  // Search strings are asserted in Russian; the default locale is now en.
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
  // jsdom lacks both matchMedia and scrollIntoView; the menu placement reads
  // matchMedia on open and the layout effect scrolls the selected row.
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("ModelPicker", () => {
  it("opens the listbox with every model on trigger click", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters the list as the user types in the search field", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "claude");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Claude Sonnet");
  });

  it("matches against the wire id too, not only the display name", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "deepseek");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("DeepSeek R1");
  });

  it("shows an empty message when no model matches the query", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Ничего не найдено")).toBeTruthy();
  });

  it("restores all options when the query is cleared", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "claude");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Очистить поиск" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selecting a filtered model fires onChange and closes the menu", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "sonnet");
    await user.click(screen.getByRole("option", { name: "Claude Sonnet" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("claude");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clears the filter when the menu closes and reopens", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.type(screen.getByPlaceholderText("Поиск моделей…"), "claude");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    // First Escape clears the filter, a second one closes the menu.
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect((screen.getByPlaceholderText("Поиск моделей…") as HTMLInputElement).value).toBe("");
  });

  it("shows a loading message instead of the empty list while models are loading", async () => {
    const user = userEvent.setup();
    // The trigger stays clickable while loading so the menu can show progress.
    renderPicker({ models: [], loading: true });
    await user.click(screen.getByRole("button", { name: "Загрузка…" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByText("Загрузка моделей…")).toBeTruthy();
    expect(screen.queryByText("Список пуст")).toBeNull();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("falls back to the empty-list message once loading finishes", async () => {
    const user = userEvent.setup();
    renderPicker({ models: [], loading: false, model: "" });
    await user.click(screen.getByRole("button", { name: "Выбрать модель" }));
    expect(screen.getByText("Список пуст")).toBeTruthy();
    expect(screen.queryByText("Загрузка моделей…")).toBeNull();
  });

  it("shows a single loader chip on the trigger while params load", () => {
    renderPicker({ paramsLoading: true, showParamsMenu: true });
    expect(screen.getByLabelText("Загрузка настроек модели…")).toBeTruthy();
    expect(screen.getByRole("button", { name: /GPT-4o Fast/ }).getAttribute("aria-busy")).toBe("true");
  });

  it("shows a loader on the settings-style trigger while params load", () => {
    renderPicker({
      variant: "block",
      paramsLoading: true,
      showParamsMenu: true,
    });
    expect(screen.getByLabelText("Загрузка настроек модели…")).toBeTruthy();
  });

  it("shows effort/context chips from stored values before options load", () => {
    renderPicker({
      params: [],
      paramValues: { reasoning_effort: "high", context: "200k" },
    });
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("200K")).toBeTruthy();
  });

  it("keeps the param loader visible while models are still loading", () => {
    renderPicker({ paramsLoading: true, loading: true, showParamsMenu: true });
    expect(screen.getByLabelText("Загрузка настроек модели…")).toBeTruthy();
  });

  it("shows a loader in the ⋯ flyout while params are fetched", async () => {
    const user = userEvent.setup();
    let resolveOpen: () => void = () => {};
    const onParamsOpen = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    renderPicker({
      showParamsMenu: true,
      onParamsOpen,
      params: [
        {
          id: "fast",
          name: "Fast",
          currentValue: "false",
          options: [
            { value: "false", name: "Not Fast" },
            { value: "true", name: "Fast" },
          ],
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "GPT-4o Fast" }));
    await user.click(screen.getAllByRole("button", { name: "Fast" })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("auto");
    expect(dialog.textContent).toContain("Загрузка настроек модели…");
    resolveOpen();
  });

  it("the ⋯ flyout renders the target model's params, not the current model's", async () => {
    const user = userEvent.setup();
    const current = {
      id: "effort",
      name: "Effort",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    const target = {
      id: "effort",
      name: "Effort",
      currentValue: "max",
      options: [
        { value: "max", name: "Max" },
        { value: "ultra", name: "Ultra" },
      ],
    };
    renderPicker({
      showParamsMenu: true,
      params: [current],
      paramsByModel: { claude: [target] },
      onParamsOpen: () => {},
    });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    // Row order follows `models`: [0]=gpt-4o, [1]=claude, [2]=deepseek.
    await user.click(screen.getAllByRole("button", { name: "Effort" })[1]);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Ultra");
    expect(dialog.textContent).not.toContain("Low");
    // The target's own currentValue marks the checked row, not the session's.
    const checked = dialog.querySelectorAll('[aria-checked="true"]');
    expect(checked).toHaveLength(1);
    expect(checked[0].textContent).toContain("Max");
  });

  it("picking an option in another model's flyout fires onParamsChange with that model", async () => {
    const user = userEvent.setup();
    const onParamsChange = vi.fn();
    renderPicker({
      showParamsMenu: true,
      params: [
        {
          id: "effort",
          name: "Effort",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
      paramsByModel: {
        claude: [
          {
            id: "effort",
            name: "Effort",
            currentValue: "max",
            options: [
              { value: "max", name: "Max" },
              { value: "ultra", name: "Ultra" },
            ],
          },
        ],
      },
      onParamsOpen: () => {},
      onParamsChange,
    });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    await user.click(screen.getAllByRole("button", { name: "Effort" })[1]);
    await user.click(await screen.findByRole("menuitemradio", { name: "Ultra" }));
    expect(onParamsChange).toHaveBeenCalledWith("claude", { effort: "ultra" });
  });

  it("the flyout keeps the loader until the target model's params arrive", async () => {
    const user = userEvent.setup();
    let resolveOpen: () => void = () => {};
    const onParamsOpen = () =>
      new Promise<void>((resolve) => {
        resolveOpen = resolve;
      });
    renderPicker({
      showParamsMenu: true,
      params: [
        {
          id: "effort",
          name: "Effort",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
      paramsByModel: {
        claude: [
          {
            id: "effort",
            name: "Effort",
            currentValue: "max",
            options: [
              { value: "max", name: "Max" },
              { value: "ultra", name: "Ultra" },
            ],
          },
        ],
      },
      onParamsOpen,
    });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    await user.click(screen.getAllByRole("button", { name: "Effort" })[1]);
    const dialog = await screen.findByRole("dialog");
    // Busy: only the loader row — no stale options from either model.
    expect(dialog.textContent).toContain("Загрузка настроек модели…");
    expect(dialog.textContent).not.toContain("Ultra");
    resolveOpen();
    expect(await screen.findByText("Ultra")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Загрузка настроек модели…");
  });
});
