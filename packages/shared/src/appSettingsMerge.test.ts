import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./index.js";
import {
  SETTINGS_SCHEMA_VERSION,
  mergeClientAppSettings,
  normalizeChatMetaChips,
  readSettingsSchema,
} from "./appSettingsMerge.js";

describe("normalizeChatMetaChips", () => {
  it("keeps console when schema is current", () => {
    const chips = ["folder", "thoughts", "mcp", "context"] as const;
    expect(normalizeChatMetaChips(chips, SETTINGS_SCHEMA_VERSION)).toEqual([...chips]);
  });

  it("adds console for legacy settings without it", () => {
    const chips = ["folder", "thoughts", "mcp", "context"];
    expect(normalizeChatMetaChips(chips, 1)).toEqual([...chips, "console"]);
  });

  it("does not duplicate console", () => {
    const chips = ["folder", "console"];
    expect(normalizeChatMetaChips(chips, 1)).toEqual(chips);
  });
});

describe("mergeClientAppSettings", () => {
  it("migrates legacy chat meta chips from API payload", () => {
    const merged = mergeClientAppSettings({
      chatMetaChips: ["folder", "thoughts", "mcp", "context"],
    });
    expect(merged.chatMetaChips).toContain("console");
    expect(merged.settingsSchema).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("respects console disabled after schema upgrade", () => {
    const merged = mergeClientAppSettings({
      settingsSchema: SETTINGS_SCHEMA_VERSION,
      chatMetaChips: ["folder", "thoughts", "mcp", "context"],
    });
    expect(merged.chatMetaChips).not.toContain("console");
  });

  it("falls back to defaults for missing payload", () => {
    expect(mergeClientAppSettings(null).chatMetaChips).toEqual(DEFAULT_SETTINGS.chatMetaChips);
  });

  it("defaults chat toolbar style to classic buttons", () => {
    expect(mergeClientAppSettings({}).chatToolbarStyle).toBe("classic");
    expect(mergeClientAppSettings({ chatToolbarStyle: "minimal" }).chatToolbarStyle).toBe("minimal");
    expect(mergeClientAppSettings({ chatToolbarStyle: "weird" }).chatToolbarStyle).toBe("classic");
  });
});

describe("readSettingsSchema", () => {
  it("defaults to 1 when absent", () => {
    expect(readSettingsSchema({})).toBe(1);
    expect(readSettingsSchema(null)).toBe(1);
  });
});
