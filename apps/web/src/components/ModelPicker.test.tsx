// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("renders Recent and Favorites sections above the full list", async () => {
    const user = userEvent.setup();
    renderPicker({ recentModels: ["deepseek"], favoriteModels: ["claude"] });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    expect(await screen.findByText("Избранное")).toBeTruthy();
    expect(screen.getByText("Недавние")).toBeTruthy();
    // Duplicated ids: favorited claude also stays in the main list. The star
    // marker must appear on every row showing that model, nowhere else.
    const starred = screen
      .getAllByRole("option")
      .filter((el) => el.querySelector("svg") && el.textContent?.includes("Claude Sonnet"));
    expect(starred.length).toBeGreaterThan(0);
    const unstarredDeepSeek = screen
      .getAllByRole("option")
      .filter((el) => !el.querySelector("svg") && el.textContent?.includes("DeepSeek R1"));
    expect(unstarredDeepSeek.length).toBeGreaterThan(0);
  });

  it("hides pinned sections while a search filter is active", async () => {
    const user = userEvent.setup();
    renderPicker({ recentModels: ["deepseek"], favoriteModels: ["claude"] });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    await screen.findByText("Избранное");
    await user.type(screen.getByRole("textbox"), "dee");
    expect(screen.queryByText("Избранное")).toBeNull();
    expect(screen.queryByText("Недавние")).toBeNull();
    expect(screen.getAllByRole("option", { name: /DeepSeek R1/ })).toHaveLength(1);
  });

  it("right-click on a row opens the favorites menu and toggles it", async () => {
    const user = userEvent.setup();
    const onToggleFavorite = vi.fn();
    renderPicker({ onToggleFavorite, favoriteModels: [] });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    const row = await screen.findByRole("option", { name: /DeepSeek R1/ });
    await user.pointer({ target: row, keys: "[MouseRight]" });
    const item = await screen.findByRole("menuitem", { name: "В избранное" });
    await user.click(item);
    expect(onToggleFavorite).toHaveBeenCalledWith("deepseek");
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("right-click on a favorite offers removal instead", async () => {
    const user = userEvent.setup();
    const onToggleFavorite = vi.fn();
    renderPicker({ onToggleFavorite, favoriteModels: ["claude"] });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    // The favorite row appears twice (section + main list); either may be clicked.
    const rows = screen
      .getAllByRole("option")
      .filter((el) => el.textContent?.includes("Claude Sonnet"));
    await user.pointer({ target: rows[0], keys: "[MouseRight]" });
    await user.click(await screen.findByRole("menuitem", { name: "Убрать из избранного" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("claude");
  });

  it("centers the favorites-section row when the selected model is favorited", async () => {
    const user = userEvent.setup();
    // Track which DOM node gets scrolled. The favorited model renders twice
    // (Избранное + general list); the target must be the favorites copy, which
    // comes first in DOM order and carries the section star marker.
    const scrolled: HTMLElement[] = [];
    HTMLElement.prototype.scrollIntoView = function scroll(this: HTMLElement) {
      scrolled.push(this);
    };
    renderPicker({ model: "claude", favoriteModels: ["claude"] });
    await user.click(screen.getByRole("button", { name: /Claude Sonnet/ }));
    await screen.findByText("Избранное");
    const rows = screen
      .getAllByRole("option")
      .filter((el) => el.textContent?.includes("Claude Sonnet"));
    expect(rows).toHaveLength(2);
    expect(scrolled.length).toBeGreaterThan(0);
    const last = scrolled[scrolled.length - 1];
    const favRow = rows[0];
    // The ref lives on the wrapper div; accept either the row or its wrapper.
    expect(last === favRow || last?.contains(favRow)).toBe(true);
  });

  it("opens the ⋯ flyout from a favorites row while the general-list copy is scrolled away", async () => {
    const user = userEvent.setup();
    const effort = {
      id: "effort",
      name: "Effort",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    renderPicker({
      showParamsMenu: true,
      favoriteModels: ["claude"],
      params: [effort],
      paramsByModel: { claude: [effort] },
      onParamsOpen: () => {},
    });
    await user.click(screen.getByRole("button", { name: /GPT-4o Fast/ }));
    // Rows in DOM order: claude (Избранное), gpt-4o, claude (general list), deepseek.
    const rows = await screen.findAllByRole("option");
    const favRow = rows[0].parentElement as HTMLElement;
    const mainRow = rows[2].parentElement as HTMLElement;
    const list = favRow.parentElement as HTMLElement;
    const box = (top: number) =>
      ({
        top,
        left: 100,
        bottom: top + 30,
        right: 300,
        width: 200,
        height: 30,
        x: 100,
        y: top,
      }) as DOMRect;
    // jsdom reports zero rects, so the picker's "⋯ scrolled out of the list"
    // check is inert here: give the list a viewport and push the general-list
    // copy far below it, the way a long model list looks in the browser.
    list.getBoundingClientRect = () => box(100);
    within(favRow).getByRole("button", { name: "Effort" }).getBoundingClientRect = () => box(120);
    within(mainRow).getByRole("button", { name: "Effort" }).getBoundingClientRect = () => box(1400);

    await user.click(within(favRow).getByRole("button", { name: "Effort" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
