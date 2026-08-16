// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@acprocess/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { ThemeToggle } from "./ThemeToggle";

const apiMock = vi.hoisted(() => ({
  // Static import is impossible here: vi.mock factories are hoisted above
  // imports, so DEFAULT_SETTINGS is uninitialized at factory runtime.
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => {
    const { DEFAULT_SETTINGS: defaults } = await import("@acprocess/shared");
    return { ...defaults, ...patch };
  }),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

// Mirrors AppShell's wiring: the store's theme drives the toggle and the
// toggle flips it back through the store's setTheme action.
function ToggleHarness() {
  const theme = useAppStore((s) => s.settings.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  return <ThemeToggle theme={theme} onToggle={() => void setTheme(theme === "light" ? "dark" : "light")} />;
}

function renderToggle() {
  return render(
    <I18nProvider>
      <ToggleHarness />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ settings: DEFAULT_SETTINGS });
  vi.clearAllMocks();
});

describe("ThemeToggle", () => {
  it("shows the dark-theme label while in light mode", () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "light" } });
    renderToggle();
    const button = screen.getByRole("button", { name: "Тёмная тема" });
    expect(button.getAttribute("data-mode")).toBe("light");
  });

  it("shows the light-theme label while in dark mode", () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "dark" } });
    renderToggle();
    const button = screen.getByRole("button", { name: "Светлая тема" });
    expect(button.getAttribute("data-mode")).toBe("dark");
  });

  it("flips the store theme to dark on click", async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "light" } });
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Тёмная тема" }));
    await waitFor(() => expect(useAppStore.getState().settings.theme).toBe("dark"));
    expect(apiMock.updateSettings).toHaveBeenCalledWith({ theme: "dark" });
    const button = screen.getByRole("button", { name: "Светлая тема" });
    expect(button.getAttribute("data-mode")).toBe("dark");
  });

  it("flips back to light on a second click", async () => {
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: "dark" } });
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Светлая тема" }));
    await waitFor(() => expect(useAppStore.getState().settings.theme).toBe("light"));
    expect(apiMock.updateSettings).toHaveBeenCalledWith({ theme: "light" });
    expect(screen.getByRole("button", { name: "Тёмная тема" }).getAttribute("data-mode")).toBe("light");
  });
});
