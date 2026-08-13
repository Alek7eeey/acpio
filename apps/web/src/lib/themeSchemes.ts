/**
 * Theme palettes selectable in Settings → Interface. "" means "use the
 * system palette" (the current CSS theme defaults) — nothing is overridden.
 * Each scheme overrides a subset of the CSS custom properties from
 * global.css; unlisted variables keep the theme's defaults.
 */
export type ThemeScheme = {
  id: string;
  name: string;
  vars: Record<string, string>;
};

export const LIGHT_SCHEMES: ThemeScheme[] = [
  {
    id: "emerald",
    name: "Изумрудный",
    vars: {
      "--accent": "#0f9d58",
      "--accent-soft": "rgba(15, 157, 88, 0.12)",
      "--accent-hover": "#0b7d46",
      "--bg": "#f4faf6",
      "--bg-secondary": "#e9f2ec",
      "--surface": "#ffffff",
      "--surface-2": "#fafdfb",
      "--border": "#cfe5d8",
      "--border-soft": "#e2efe6",
      "--text-secondary": "#5d7468",
    },
  },
  {
    id: "violet",
    name: "Фиолетовый",
    vars: {
      "--accent": "#7c3aed",
      "--accent-soft": "rgba(124, 58, 237, 0.12)",
      "--accent-hover": "#6d28d9",
      "--bg": "#f8f6fd",
      "--bg-secondary": "#efeafb",
      "--surface": "#ffffff",
      "--surface-2": "#fbfafe",
      "--border": "#ddd5f2",
      "--border-soft": "#eae5f8",
      "--text-secondary": "#6d6390",
    },
  },
  {
    id: "sunset",
    name: "Закат",
    vars: {
      "--accent": "#ea580c",
      "--accent-soft": "rgba(234, 88, 12, 0.13)",
      "--accent-hover": "#c2410c",
      "--bg": "#fdf8f4",
      "--bg-secondary": "#f8efe6",
      "--surface": "#ffffff",
      "--surface-2": "#fefbf8",
      "--border": "#f0dccb",
      "--border-soft": "#f7ebe0",
      "--text-secondary": "#8a6a52",
    },
  },
  {
    id: "ocean",
    name: "Океан",
    vars: {
      "--accent": "#0e7490",
      "--accent-soft": "rgba(14, 116, 144, 0.12)",
      "--accent-hover": "#155e75",
      "--bg": "#f3f9fb",
      "--bg-secondary": "#e6f1f5",
      "--surface": "#ffffff",
      "--surface-2": "#f8fcfd",
      "--border": "#c9e0e8",
      "--border-soft": "#deedf2",
      "--text-secondary": "#57737d",
    },
  },
];

export const DARK_SCHEMES: ThemeScheme[] = [
  {
    id: "emerald",
    name: "Изумрудный",
    vars: {
      "--accent": "#34d399",
      "--accent-soft": "rgba(52, 211, 153, 0.16)",
      "--accent-hover": "#6ee7b7",
      "--bg": "#0c110e",
      "--bg-secondary": "#131a16",
      "--surface": "#131a16",
      "--surface-2": "#18211c",
      "--border": "#233329",
      "--border-soft": "#1b2820",
      "--text-secondary": "#86a291",
    },
  },
  {
    id: "violet",
    name: "Фиолетовый",
    vars: {
      "--accent": "#a78bfa",
      "--accent-soft": "rgba(167, 139, 250, 0.16)",
      "--accent-hover": "#c4b5fd",
      "--bg": "#0f0d16",
      "--bg-secondary": "#16131f",
      "--surface": "#16131f",
      "--surface-2": "#1c1829",
      "--border": "#2c2540",
      "--border-soft": "#221d31",
      "--text-secondary": "#9489ad",
    },
  },
  {
    id: "sunset",
    name: "Закат",
    vars: {
      "--accent": "#fb923c",
      "--accent-soft": "rgba(251, 146, 60, 0.16)",
      "--accent-hover": "#fdba74",
      "--bg": "#150f09",
      "--bg-secondary": "#1e1710",
      "--surface": "#1e1710",
      "--surface-2": "#261d13",
      "--border": "#3a2d1e",
      "--border-soft": "#2c2215",
      "--text-secondary": "#b09374",
    },
  },
  {
    id: "ocean",
    name: "Океан",
    vars: {
      "--accent": "#38bdf8",
      "--accent-soft": "rgba(56, 189, 248, 0.16)",
      "--accent-hover": "#7dd3fc",
      "--bg": "#0a1216",
      "--bg-secondary": "#111b20",
      "--surface": "#111b20",
      "--surface-2": "#162229",
      "--border": "#1f3038",
      "--border-soft": "#18252b",
      "--text-secondary": "#7d97a2",
    },
  },
];

export function schemeById(
  theme: "light" | "dark",
  id: string,
): ThemeScheme | undefined {
  return (theme === "dark" ? DARK_SCHEMES : LIGHT_SCHEMES).find((s) => s.id === id);
}

/** Display colors of the system palettes ("" = default) for the swatch cards. */
export const SYSTEM_SWATCH: Record<"light" | "dark", { accent: string; bg: string; surface: string }> = {
  light: { accent: "#0866ff", bg: "#f7f8fa", surface: "#ffffff" },
  dark: { accent: "#4b8dff", bg: "#0f1115", surface: "#171a21" },
};
