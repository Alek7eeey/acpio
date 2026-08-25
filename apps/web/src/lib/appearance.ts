import type { AppSettings } from "@acpio/shared";
import { customScheme, schemeById } from "./themeSchemes";

/** Font family ids selectable in Settings → Interface. "" = default (Figtree). */
export const FONT_FAMILIES: Record<string, string> = {
  figtree: '"Figtree", sans-serif',
  inter: '"Inter", system-ui, -apple-system, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

/** Root font-size ids. "" = default (16px). */
export const FONT_SIZES: Record<string, string> = {
  sm: "15px",
  lg: "17px",
};

/** Scheme vars currently applied inline, so they can be removed on switch. */
const appliedSchemeVars = new Set<string>();

function setVar(key: string, value: string | null) {
  const doc = document.documentElement;
  if (value) doc.style.setProperty(key, value);
  else doc.style.removeProperty(key);
}

/**
 * Apply the user's appearance settings: font family, root font size and the
 * palette for the currently displayed theme. "" values restore the system
 * defaults. The theme is read from the data-theme attribute (the display
 * truth, kept in sync by applyTheme) — never from settings.theme, which may
 * lag behind or echo a stale server value.
 */
export function applyAppearance(settings: AppSettings) {
  setVar("--font", FONT_FAMILIES[settings.fontFamily] ?? null);
  setVar("font-size", FONT_SIZES[settings.fontSize] ?? null);

  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const schemeId = theme === "dark" ? settings.darkScheme : settings.lightScheme;
  let scheme = schemeById(theme, schemeId);
  if (schemeId === "custom") {
    const accent = theme === "dark" ? settings.darkAccent : settings.lightAccent;
    const bg = theme === "dark" ? settings.darkBg : settings.lightBg;
    const surface = theme === "dark" ? settings.darkSurface : settings.lightSurface;
    if (accent && bg && surface) scheme = customScheme(theme, accent, bg, surface);
    else scheme = undefined; // custom chosen but colors not set yet → system palette
  }
  appliedSchemeVars.forEach((key) => document.documentElement.style.removeProperty(key));
  appliedSchemeVars.clear();
  if (scheme) {
    for (const [key, value] of Object.entries(scheme.vars)) {
      document.documentElement.style.setProperty(key, value);
      appliedSchemeVars.add(key);
    }
  }
}
