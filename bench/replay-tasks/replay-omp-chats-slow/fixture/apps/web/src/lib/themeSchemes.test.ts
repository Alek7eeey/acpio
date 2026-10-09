import { describe, it, expect } from "vitest";
import {
  LIGHT_SCHEMES,
  DARK_SCHEMES,
  SYSTEM_SWATCH,
  schemeById,
  type ThemeScheme,
} from "./themeSchemes";

/** CSS custom properties every scheme overrides (from global.css defaults). */
const REQUIRED_VARS = [
  "--accent",
  "--accent-soft",
  "--accent-hover",
  "--bg",
  "--bg-secondary",
  "--surface",
  "--surface-2",
  "--border",
  "--border-soft",
  "--text-secondary",
] as const;

describe("LIGHT_SCHEMES / DARK_SCHEMES structure", () => {
  it("exports non-empty light and dark scheme lists", () => {
    expect(LIGHT_SCHEMES.length).toBeGreaterThan(0);
    expect(DARK_SCHEMES.length).toBeGreaterThan(0);
  });

  it.each([...LIGHT_SCHEMES, ...DARK_SCHEMES] as ThemeScheme[])(
    "scheme %s has a non-empty id, name and vars record",
    (scheme) => {
      expect(scheme.id).toBeTruthy();
      expect(typeof scheme.name).toBe("string");
      expect(scheme.name.length).toBeGreaterThan(0);
      expect(scheme.vars).toBeTruthy();
      expect(typeof scheme.vars).toBe("object");
    },
  );

  it.each([...LIGHT_SCHEMES, ...DARK_SCHEMES] as ThemeScheme[])(
    "scheme %s overrides every required CSS custom property",
    (scheme) => {
      for (const key of REQUIRED_VARS) {
        expect(scheme.vars).toHaveProperty(key);
      }
    },
  );

  it.each([...LIGHT_SCHEMES, ...DARK_SCHEMES] as ThemeScheme[])(
    "scheme %s has a non-empty color value for every var",
    (scheme) => {
      for (const [key, value] of Object.entries(scheme.vars)) {
        expect(value, key).toBeTruthy();
      }
    },
  );

  it("has unique ids within LIGHT_SCHEMES", () => {
    const ids = LIGHT_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique ids within DARK_SCHEMES", () => {
    const ids = DARK_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("schemeById", () => {
  it("returns the light scheme for the given id", () => {
    expect(schemeById("light", "emerald")?.vars["--accent"]).toBe("#0f9d58");
  });

  it("returns the dark scheme for the given id", () => {
    expect(schemeById("dark", "emerald")?.vars["--accent"]).toBe("#34d399");
  });

  it("scopes lookups by theme — the light and dark entries differ", () => {
    const light = schemeById("light", "ocean");
    const dark = schemeById("dark", "ocean");
    expect(light?.id).toBe("ocean");
    expect(dark?.id).toBe("ocean");
    expect(light?.vars["--bg"]).not.toBe(dark?.vars["--bg"]);
  });

  it("returns undefined for an unknown id", () => {
    expect(schemeById("light", "nope")).toBeUndefined();
    expect(schemeById("dark", "nope")).toBeUndefined();
  });

  it("returns undefined for an empty id", () => {
    expect(schemeById("light", "")).toBeUndefined();
    expect(schemeById("dark", "")).toBeUndefined();
  });

  it("returns a scheme from the list even when the same id exists in the other theme", () => {
    for (const scheme of LIGHT_SCHEMES) {
      expect(schemeById("light", scheme.id)).toBe(scheme);
    }
    for (const scheme of DARK_SCHEMES) {
      expect(schemeById("dark", scheme.id)).toBe(scheme);
    }
  });
});

describe("SYSTEM_SWATCH", () => {
  it("exposes both themes with accent, bg and surface strings", () => {
    for (const theme of ["light", "dark"] as const) {
      const swatch = SYSTEM_SWATCH[theme];
      expect(typeof swatch.accent).toBe("string");
      expect(typeof swatch.bg).toBe("string");
      expect(typeof swatch.surface).toBe("string");
      expect(swatch.accent.length).toBeGreaterThan(0);
      expect(swatch.bg.length).toBeGreaterThan(0);
      expect(swatch.surface.length).toBeGreaterThan(0);
    }
  });

  it("documents the system palette colors", () => {
    expect(SYSTEM_SWATCH.light).toEqual({ accent: "#0866ff", bg: "#f7f8fa", surface: "#ffffff" });
    expect(SYSTEM_SWATCH.dark).toEqual({ accent: "#4b8dff", bg: "#0f1115", surface: "#171a21" });
  });
});
