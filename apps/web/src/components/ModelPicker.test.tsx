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
});
