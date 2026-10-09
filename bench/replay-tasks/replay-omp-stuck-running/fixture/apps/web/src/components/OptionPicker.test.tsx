// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptionPicker, type OptionPickerItem } from "./OptionPicker";

const options: OptionPickerItem[] = [
  { value: "gpt", label: "GPT-4" },
  { value: "claude", label: "Claude", hint: "fast" },
];

beforeEach(() => {
  // jsdom lacks both matchMedia and scrollIntoView; the menu placement reads
  // matchMedia on open and the layout effect scrolls the selected row.
  // Stub them so opening the menu behaves like a non-narrow real viewport.
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

describe("OptionPicker", () => {
  it("shows the placeholder when value matches no option", () => {
    render(<OptionPicker value="nope" options={options} onChange={vi.fn()} placeholder="Выберите модель" />);
    expect(screen.getByRole("button", { name: "Выберите модель" })).toBeTruthy();
  });

  it.each([
    { value: "gpt", expected: "GPT-4" },
    { value: "claude", expected: "Claude · fast" },
  ])("shows the selected option label ($expected) on the trigger", ({ value, expected }) => {
    render(<OptionPicker value={value} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: expected })).toBeTruthy();
  });

  it("opens the listbox on trigger click with all options", async () => {
    const user = userEvent.setup();
    render(<OptionPicker value="gpt" options={options} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "GPT-4" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("marks the selected option with aria-selected", async () => {
    const user = userEvent.setup();
    render(<OptionPicker value="claude" options={options} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Claude · fast" }));
    expect(screen.getByRole("option", { name: /Claude/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: /GPT-4/ }).getAttribute("aria-selected")).toBe("false");
  });

  it.each([
    { value: "gpt", label: "GPT-4" },
    { value: "claude", label: "Claude" },
  ])("clicking option $label fires onChange with its value and closes the menu", async ({ value, label }) => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<OptionPicker value="gpt" options={options} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "GPT-4" }));
    await user.click(screen.getByRole("option", { name: new RegExp(label) }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(value);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not open the menu when disabled", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<OptionPicker value="gpt" options={options} onChange={onChange} disabled />);
    await user.click(screen.getByRole("button", { name: "GPT-4" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the empty label when there are no options", async () => {
    const user = userEvent.setup();
    render(<OptionPicker value="" options={[]} onChange={vi.fn()} emptyLabel="Нет опций" />);
    await user.click(screen.getByRole("button", { name: "…" }));
    expect(screen.getByText("Нет опций")).toBeTruthy();
  });
});
