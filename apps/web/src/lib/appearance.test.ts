// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@acprocess/shared";
import { FONT_FAMILIES, FONT_SIZES, applyAppearance } from "./appearance";

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

describe("FONT_FAMILIES / FONT_SIZES", () => {
  it("maps every font family id to a CSS font stack", () => {
    expect(FONT_FAMILIES.figtree).toBe('"Figtree", sans-serif');
    expect(FONT_FAMILIES.inter).toBe('"Inter", system-ui, -apple-system, sans-serif');
    expect(FONT_FAMILIES.system).toBe('system-ui, -apple-system, "Segoe UI", sans-serif');
  });

  it("maps every font size id to a px value", () => {
    expect(FONT_SIZES.sm).toBe("15px");
    expect(FONT_SIZES.lg).toBe("17px");
  });
});

describe("applyAppearance: font settings", () => {
  it("applies the font family and root font size", () => {
    applyAppearance(settings({ fontFamily: "inter", fontSize: "lg" }));
    expect(document.documentElement.style.getPropertyValue("--font")).toBe(
      '"Inter", system-ui, -apple-system, sans-serif',
    );
    expect(document.documentElement.style.getPropertyValue("font-size")).toBe("17px");
  });

  it("removes the font family override for an unknown id", () => {
    applyAppearance(settings({ fontFamily: "comic-sans" }));
    expect(document.documentElement.style.getPropertyValue("--font")).toBe("");
  });

  it("removes the font size override for an unknown id", () => {
    applyAppearance(settings({ fontSize: "xl" }));
    expect(document.documentElement.style.getPropertyValue("font-size")).toBe("");
  });
});

describe("applyAppearance: theme scheme", () => {
  it("applies the light scheme vars when data-theme is not dark", () => {
    applyAppearance(settings({ lightScheme: "emerald" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0f9d58");
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("#ffffff");
  });

  it("applies the dark scheme vars when data-theme is dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    applyAppearance(settings({ darkScheme: "violet" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#a78bfa");
  });

  it("removes previously applied scheme vars when switching schemes", () => {
    applyAppearance(settings({ lightScheme: "emerald" }));
    applyAppearance(settings({ lightScheme: "sunset" }));
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--accent")).toBe("#ea580c");
    expect(style.getPropertyValue("--accent-soft")).toBe("rgba(234, 88, 12, 0.13)");
    expect(style.getPropertyValue("--bg")).toBe("#fdf8f4");
  });

  it("removes all scheme vars when the scheme id is empty", () => {
    applyAppearance(settings({ lightScheme: "emerald" }));
    applyAppearance(settings({ lightScheme: "" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("");
  });

  it("applies nothing when the theme's scheme id is unknown", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    applyAppearance(settings({ darkScheme: "nope" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });

  it("reads the display theme from data-theme, not from settings.theme", () => {
    applyAppearance(settings({ theme: "dark", lightScheme: "emerald" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0f9d58");

    document.documentElement.setAttribute("data-theme", "dark");
    applyAppearance(settings({ theme: "light", darkScheme: "emerald" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#34d399");
  });

  it("keeps font overrides applied alongside scheme vars", () => {
    applyAppearance(settings({ fontFamily: "system", fontSize: "sm", lightScheme: "ocean" }));
    expect(document.documentElement.style.getPropertyValue("--font")).toBe(
      'system-ui, -apple-system, "Segoe UI", sans-serif',
    );
    expect(document.documentElement.style.getPropertyValue("font-size")).toBe("15px");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0e7490");
  });
});
