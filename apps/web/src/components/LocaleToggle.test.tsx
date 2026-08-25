// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { LocaleToggle } from "./LocaleToggle";

const apiMock = vi.hoisted(() => ({
  // Static import is impossible here: vi.mock factories are hoisted above
  // imports, so DEFAULT_SETTINGS is uninitialized at factory runtime.
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
    const { DEFAULT_SETTINGS: defaults } = await import("@acpio/shared");
    return { ...defaults, ...patch };
  }),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

// jsdom reports zero-sized rects, so the toggle would never position its
// portal menu and would keep it `visibility: hidden`. Give elements a real
// rect so the menu actually becomes visible, like in a browser.
const layoutRect = { width: 120, height: 32, top: 40, left: 20, right: 140, bottom: 72, x: 20, y: 40 } as DOMRect;
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

function seedLocale(locale: "ru" | "en") {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, locale } });
}

function renderToggle() {
  return render(
    <I18nProvider>
      <LocaleToggle />
    </I18nProvider>,
  );
}

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = () => layoutRect;
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  cleanup();
  useAppStore.setState({ settings: DEFAULT_SETTINGS });
  vi.clearAllMocks();
});

describe("LocaleToggle", () => {
  it("shows the current locale label on the trigger", () => {
    seedLocale("ru");
    renderToggle();
    const trigger = screen.getByRole("button", { name: "Язык интерфейса" });
    expect(within(trigger).getByText("Русский")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the menu with both locale options", async () => {
    seedLocale("ru");
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Язык интерфейса" }));
    expect(screen.getByRole("option", { name: "Русский" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Язык интерфейса" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("switches the store locale to en when English is selected", async () => {
    seedLocale("ru");
    const user = userEvent.setup();
    renderToggle();
    // Keep the handle: after the switch the trigger's aria-label follows the
    // new locale (ru "Язык интерфейса" → en "Language").
    const trigger = screen.getByRole("button", { name: "Язык интерфейса" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "English" }));
    await waitFor(() => expect(useAppStore.getState().settings.locale).toBe("en"));
    expect(apiMock.updateSettings).toHaveBeenCalledWith({ locale: "en" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(within(trigger).getByText("English")).toBeTruthy();
  });

  it("selecting the active locale only closes the menu", async () => {
    seedLocale("ru");
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Язык интерфейса" }));
    await user.click(screen.getByRole("option", { name: "Русский" }));
    expect(useAppStore.getState().settings.locale).toBe("ru");
    expect(apiMock.updateSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
