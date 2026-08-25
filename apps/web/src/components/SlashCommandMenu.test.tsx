// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import type { SlashCommandDto } from "@acpio/shared";
import { I18nProvider } from "../lib/i18n";
import { useAppStore } from "../lib/store";
import { SlashCommandMenu } from "./SlashCommandMenu";

const commands: SlashCommandDto[] = [
  { name: "compact", description: "Сжать тему" },
  { name: "ask", description: "Задать вопрос", inputHint: "текст" },
];

beforeEach(() => {
  // Section labels are asserted in Russian; the default locale is now en.
  useAppStore.setState((s) => ({ settings: { ...s.settings, locale: "ru" } }));
});

function Harness({
  open,
  list,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: {
  open: boolean;
  list: SlashCommandDto[];
  activeIndex: number;
  onSelect: (command: SlashCommandDto) => void;
  onActiveIndexChange: (index: number) => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <I18nProvider>
      <div ref={anchorRef} />
      <SlashCommandMenu
        open={open}
        commands={list}
        activeIndex={activeIndex}
        anchorRef={anchorRef}
        onSelect={onSelect}
        onActiveIndexChange={onActiveIndexChange}
      />
    </I18nProvider>
  );
}

function renderMenu(overrides: Partial<Parameters<typeof Harness>[0]> = {}) {
  const onSelect = vi.fn();
  const onActiveIndexChange = vi.fn();
  const view = render(
    <Harness
      open
      list={commands}
      activeIndex={0}
      onSelect={onSelect}
      onActiveIndexChange={onActiveIndexChange}
      {...overrides}
    />,
  );
  return { onSelect, onActiveIndexChange, ...view };
}

afterEach(cleanup);

describe("SlashCommandMenu", () => {
  it("renders every command from props", () => {
    renderMenu();
    expect(screen.getByRole("option", { name: /\/compact/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /\/ask/ })).toBeTruthy();
  });

  it("highlights the active index with aria-selected", () => {
    renderMenu({ activeIndex: 1 });
    expect(screen.getByRole("option", { name: /\/ask/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: /\/compact/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("fires onSelect with the command on click", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderMenu();
    await user.click(screen.getByRole("option", { name: /\/compact/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(commands[0]);
  });

  it("puts skills above other commands with section labels", () => {
    renderMenu({
      list: [
        { name: "git-commit-ru", description: "Commit (user skill)" },
        { name: "compact", description: "Сжать тему" },
      ],
    });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toMatch(/\/git-commit-ru/);
    expect(options[1].textContent).toMatch(/\/compact/);
    expect(screen.getByText("Скиллы")).toBeTruthy();
    expect(screen.queryByText("Команды")).toBeNull();
  });

  it("reports the hovered option through onActiveIndexChange", () => {
    const { onActiveIndexChange } = renderMenu();
    fireEvent.mouseEnter(screen.getByRole("option", { name: /\/ask/ }));
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });

  it.each([
    { name: "when closed", overrides: { open: false } },
    { name: "with an empty command list", overrides: { list: [] as SlashCommandDto[] } },
  ])("renders nothing $name", ({ overrides }) => {
    renderMenu(overrides);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
