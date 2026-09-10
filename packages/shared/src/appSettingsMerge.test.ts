import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./index.js";
import {
  SETTINGS_SCHEMA_VERSION,
  mergeClientAppSettings,
  normalizeChatMetaChips,
  readSettingsSchema,
} from "./appSettingsMerge.js";

describe("normalizeChatMetaChips", () => {
  it("keeps chips when schema is current", () => {
    const chips = [
      "folder",
      "gitBranch",
      "gitChanges",
      "thoughts",
      "mcp",
      "context",
      "console",
    ] as const;
    expect(normalizeChatMetaChips(chips, SETTINGS_SCHEMA_VERSION)).toEqual([...chips]);
  });

  it("splits legacy git chip into branch and changes", () => {
    const chips = ["folder", "git", "thoughts", "mcp", "context", "console"];
    expect(normalizeChatMetaChips(chips, SETTINGS_SCHEMA_VERSION)).toEqual([
      "folder",
      "gitBranch",
      "gitChanges",
      "thoughts",
      "mcp",
      "context",
      "console",
    ]);
  });

  it("adds git chips after folder for legacy settings without them", () => {
    const chips = ["folder", "thoughts", "mcp", "context", "console"];
    expect(normalizeChatMetaChips(chips, 2)).toEqual([
      "folder",
      "gitBranch",
      "gitChanges",
      "thoughts",
      "mcp",
      "context",
      "console",
    ]);
  });

  it("adds console for legacy settings without it", () => {
    const chips = ["folder", "thoughts", "mcp", "context"];
    expect(normalizeChatMetaChips(chips, 1)).toEqual([
      "folder",
      "gitBranch",
      "gitChanges",
      "thoughts",
      "mcp",
      "context",
      "console",
    ]);
  });

  it("does not duplicate console", () => {
    const chips = ["folder", "console"];
    expect(normalizeChatMetaChips(chips, 1)).toEqual([
      "folder",
      "gitBranch",
      "gitChanges",
      "console",
    ]);
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

  it("defaults git branch position to below", () => {
    expect(mergeClientAppSettings({}).chatGitBranchPosition).toBe("below");
    expect(mergeClientAppSettings({ chatGitBranchPosition: "above" }).chatGitBranchPosition).toBe("above");
    expect(mergeClientAppSettings({ chatGitBranchPosition: "weird" }).chatGitBranchPosition).toBe("below");
  });

  it("defaults chip options and heals partial objects", () => {
    const defaults = mergeClientAppSettings({}).chatChipOptions;
    expect(defaults).toEqual({
      folder: { compress: true, truncate: "middle" },
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "linesAndFiles" },
      context: { format: "usage" },
    });
    // A stored object written by an older/newer client only has to carry the
    // fields it changed — everything else stays at its default.
    expect(
      mergeClientAppSettings({
        chatChipOptions: { folder: { compress: false, truncate: "end" } },
      }).chatChipOptions,
    ).toEqual({
      folder: { compress: false, truncate: "end" },
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "linesAndFiles" },
      context: { format: "usage" },
    });
    expect(
      mergeClientAppSettings({
        chatChipOptions: { gitChanges: { metrics: "weird" }, context: { format: "percent" } },
      }).chatChipOptions,
    ).toEqual({
      folder: { compress: true, truncate: "middle" },
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "linesAndFiles" },
      context: { format: "percent" },
    });
  });

  it("defaults deep logging to off", () => {
    expect(mergeClientAppSettings({}).diagnosticsDeepLogging).toBe(false);
    expect(mergeClientAppSettings({ diagnosticsDeepLogging: true }).diagnosticsDeepLogging).toBe(true);
  });
});

describe("readSettingsSchema", () => {
  it("defaults to 1 when absent", () => {
    expect(readSettingsSchema({})).toBe(1);
    expect(readSettingsSchema(null)).toBe(1);
  });
});
