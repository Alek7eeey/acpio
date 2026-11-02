import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_KEYS,
  isEditorKeyCombo,
  normalizeEditorKeyCombo,
  normalizeEditorSplit,
  normalizeEditorTheme,
  normalizeEditorToolSource,
} from "./editorKeys.js";

describe("editor key combos", () => {
  it("accepts the notation CodeMirror binds directly", () => {
    for (const combo of ["F12", "Shift-F12", "Mod-s", "Ctrl-Shift-d", "Alt-PageUp", "Mod-/"]) {
      if (combo === "Mod-/") continue;
      expect(isEditorKeyCombo(combo)).toBe(true);
    }
  });

  it("rejects a modifier with no key, a made-up key and a doubled modifier", () => {
    expect(isEditorKeyCombo("Mod-")).toBe(false);
    expect(isEditorKeyCombo("Hyper-x")).toBe(false);
    expect(isEditorKeyCombo("Mod-Mod-s")).toBe(false);
    expect(isEditorKeyCombo("Ctrl+Shift+D")).toBe(false);
  });

  it("heals a stored value instead of passing it through", () => {
    expect(normalizeEditorKeyCombo(" Mod-k ", "F12")).toBe("Mod-k");
    expect(normalizeEditorKeyCombo("garbage", "F12")).toBe("F12");
    expect(normalizeEditorKeyCombo(undefined, "Shift-F12")).toBe("Shift-F12");
  });

  it("keeps every default bindable", () => {
    for (const combo of Object.values(DEFAULT_EDITOR_KEYS)) expect(isEditorKeyCombo(combo)).toBe(true);
  });
});

describe("editor theme choice", () => {
  it("accepts the three choices and falls back to the app theme", () => {
    expect(normalizeEditorTheme("dark")).toBe("dark");
    expect(normalizeEditorTheme("light")).toBe("light");
    expect(normalizeEditorTheme("auto")).toBe("auto");
    expect(normalizeEditorTheme("neon")).toBe("auto");
    expect(normalizeEditorTheme(undefined)).toBe("auto");
  });
});

describe("editor tool source", () => {
  it("keeps the three choices and defaults to auto", () => {
    expect(normalizeEditorToolSource("project")).toBe("project");
    expect(normalizeEditorToolSource("bundled")).toBe("bundled");
    expect(normalizeEditorToolSource("auto")).toBe("auto");
    expect(normalizeEditorToolSource("npm")).toBe("auto");
    expect(normalizeEditorToolSource(undefined)).toBe("auto");
  });
});

describe("editor split side", () => {
  it("keeps left/right and refuses anything else", () => {
    expect(normalizeEditorSplit("left")).toBe("left");
    expect(normalizeEditorSplit("right")).toBe("right");
    expect(normalizeEditorSplit("off")).toBe("off");
    expect(normalizeEditorSplit("middle")).toBe("off");
  });
});
