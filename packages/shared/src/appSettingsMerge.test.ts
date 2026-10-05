import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  builtinProviderHeaders,
  normalizeBuiltinProviders,
} from "./index.js";
import {
  CHAT_TREE_RECENT_LIMIT_MAX,
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
      "board",
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
      "board",
      "gitBranch",
      "gitChanges",
      "thoughts",
      "mcp",
      "context",
      "console",
    ]);
  });

  it("adds board after folder for settings saved before the board chip", () => {
    const chips = ["folder", "gitBranch", "gitChanges", "thoughts", "mcp", "context", "console"];
    expect(normalizeChatMetaChips(chips, 5)).toEqual([
      "folder",
      "board",
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
      "board",
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

  it("defaults the board add-task placeholder to the card shape", () => {
    expect(mergeClientAppSettings({}).boardAddCardStyle).toBe("card");
    expect(mergeClientAppSettings({ boardAddCardStyle: "compact" }).boardAddCardStyle).toBe("compact");
    expect(mergeClientAppSettings({ boardAddCardStyle: "hidden" }).boardAddCardStyle).toBe("hidden");
    expect(mergeClientAppSettings({ boardAddCardStyle: "weird" }).boardAddCardStyle).toBe("card");
  });

  it("defaults git branch position to below", () => {
    expect(mergeClientAppSettings({}).chatGitBranchPosition).toBe("below");
    expect(mergeClientAppSettings({ chatGitBranchPosition: "above" }).chatGitBranchPosition).toBe("above");
    expect(mergeClientAppSettings({ chatGitBranchPosition: "weird" }).chatGitBranchPosition).toBe("below");
  });

  it("defaults the attach source to the browser device", () => {
    expect(mergeClientAppSettings({}).attachDefaultSource).toBe("device");
    expect(mergeClientAppSettings({ attachDefaultSource: "server" }).attachDefaultSource).toBe(
      "server",
    );
    expect(mergeClientAppSettings({ attachDefaultSource: "weird" }).attachDefaultSource).toBe(
      "device",
    );
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

  it("heals the chat-tree recent-chat limit", () => {
    expect(mergeClientAppSettings({}).chatTreeRecentLimit).toBe(0);
    expect(mergeClientAppSettings({ chatTreeRecentLimit: 7 }).chatTreeRecentLimit).toBe(7);
    expect(mergeClientAppSettings({ chatTreeRecentLimit: -3 }).chatTreeRecentLimit).toBe(0);
    expect(mergeClientAppSettings({ chatTreeRecentLimit: 12.6 }).chatTreeRecentLimit).toBe(13);
    expect(mergeClientAppSettings({ chatTreeRecentLimit: 9999 }).chatTreeRecentLimit).toBe(
      CHAT_TREE_RECENT_LIMIT_MAX,
    );
    expect(mergeClientAppSettings({ chatTreeRecentLimit: "many" }).chatTreeRecentLimit).toBe(0);
    expect(mergeClientAppSettings({ chatTreeRecentLimit: Number.NaN }).chatTreeRecentLimit).toBe(0);
  });

  it("migrates a pre-provider builtin payload from the API", () => {
    const merged = mergeClientAppSettings({
      builtinAgentUrl: "http://localhost:11434/v1",
      builtinModels: [{ id: "m1" }],
    });
    expect(merged.builtinProviders).toEqual([
      {
        id: "legacy",
        name: "Default",
        url: "http://localhost:11434/v1",
        apiKey: "",
        models: [{ id: "m1", label: "m1", contextWindow: 128_000 }],
      },
    ]);
    expect("builtinAgentUrl" in merged).toBe(false);
  });
});

describe("normalizeBuiltinProviders", () => {
  it("folds the legacy single-endpoint fields into one provider row", () => {
    const raw = {
      locale: "ru",
      builtinAgentUrl: " http://localhost:11434/v1 ",
      builtinAgentApiKey: "sk-test",
      builtinModels: [{ id: "qwen", label: "", contextWindow: 0 }],
      defaultModelByProvider: { builtin: "qwen", cursor: "grok-4.6" },
    };
    const providers = normalizeBuiltinProviders(raw);
    expect(providers).toEqual([
      {
        id: "legacy",
        name: "Основной",
        url: "http://localhost:11434/v1",
        apiKey: "sk-test",
        models: [{ id: "qwen", label: "qwen", contextWindow: 128_000 }],
      },
    ]);
    expect("builtinAgentUrl" in raw).toBe(false);
    expect("builtinAgentApiKey" in raw).toBe(false);
    expect("builtinModels" in raw).toBe(false);
    // The stored default model now names its provider explicitly.
    expect(raw.defaultModelByProvider).toEqual({ builtin: "legacy::qwen", cursor: "grok-4.6" });
  });

  it("keeps a typed context-window override through normalization", () => {
    const raw = {
      builtinProviders: [
        {
          id: "p1",
          name: "Zen",
          url: "https://opencode.ai/zen/go/v1",
          apiKey: "",
          models: [
            { id: "typed", label: "Typed", contextWindow: 64_000, contextWindowEdited: true },
            { id: "reported", label: "Reported", contextWindow: 128_000, contextWindowEdited: false },
          ],
        },
      ],
    };
    expect(normalizeBuiltinProviders(raw).flatMap((p) => p.models)).toEqual([
      { id: "typed", label: "Typed", contextWindow: 64_000, contextWindowEdited: true },
      { id: "reported", label: "Reported", contextWindow: 128_000 },
    ]);
  });

  it("rewrites bare builtin model values to composite and keeps unknown ones", () => {
    const raw = {
      builtinProviders: [
        {
          id: "p1",
          name: "Ollama",
          url: "http://localhost:11434/v1",
          apiKey: "",
          models: [{ id: "qwen", label: "Qwen", contextWindow: 32_000 }],
        },
      ],
      defaultModelByProvider: { builtin: "qwen" },
      recentModelsByProvider: { builtin: ["qwen", "gpt-4o", "qwen"] },
      favoriteModelsByProvider: { builtin: ["p1::qwen"] },
      modelParamsByProviderModel: { builtin: { qwen: { effort: "high" } } },
    };
    normalizeBuiltinProviders(raw);
    expect(raw.defaultModelByProvider).toEqual({ builtin: "p1::qwen" });
    expect(raw.recentModelsByProvider).toEqual({ builtin: ["p1::qwen", "gpt-4o"] });
    expect(raw.favoriteModelsByProvider).toEqual({ builtin: ["p1::qwen"] });
    expect(raw.modelParamsByProviderModel).toEqual({ builtin: { "p1::qwen": { effort: "high" } } });
  });

  it("heals provider rows: id-less and duplicate rows drop, name falls back", () => {
    const raw = {
      builtinProviders: [
        { id: "p1", name: "  ", url: "http://a/v1", apiKey: "", models: "junk" },
        { id: "p1", name: "dupe", url: "http://b/v1", models: [] },
        { name: "no id", url: "http://c/v1", models: [] },
        "junk",
      ],
    };
    expect(normalizeBuiltinProviders(raw)).toEqual([
      { id: "p1", name: "http://a/v1", url: "http://a/v1", apiKey: "", models: [] },
    ]);
  });

  it("keeps a fresh payload as-is", () => {
    expect(normalizeBuiltinProviders({})).toEqual([]);
    expect(normalizeBuiltinProviders({ builtinProviders: [] })).toEqual([]);
    expect(normalizeBuiltinProviders(null)).toEqual([]);
  });

  it("heals header rows: nameless rows drop, rows without headers stay absent", () => {
    const raw = {
      builtinProviders: [
        {
          id: "p1",
          name: "OpenCode",
          url: "https://opencode.ai/v1",
          apiKey: "",
          models: [],
          headers: [
            { name: " x-opencode-session ", value: "{{sessionId}}" },
            { name: "   ", value: "dropped" },
            "junk",
          ],
        },
        { id: "p2", name: "Bare", url: "http://a/v1", apiKey: "", models: [] },
      ],
    };
    expect(normalizeBuiltinProviders(raw)).toEqual([
      {
        id: "p1",
        name: "OpenCode",
        url: "https://opencode.ai/v1",
        apiKey: "",
        models: [],
        headers: [{ name: "x-opencode-session", value: "{{sessionId}}" }],
      },
      { id: "p2", name: "Bare", url: "http://a/v1", apiKey: "", models: [] },
    ]);
  });
});

describe("builtinProviderHeaders", () => {
  it("substitutes {{sessionId}} with the session id", () => {
    expect(
      builtinProviderHeaders(
        [
          { name: "x-opencode-session", value: "{{sessionId}}" },
          { name: "x-static", value: "fixed" },
          { name: "x-mixed", value: "chat-{{sessionId}}-tag" },
        ],
        "abc-123",
      ),
    ).toEqual({
      "x-opencode-session": "abc-123",
      "x-static": "fixed",
      "x-mixed": "chat-abc-123-tag",
    });
  });

  it("drops placeholder rows when no session exists (the /models probe)", () => {
    expect(
      builtinProviderHeaders([
        { name: "x-opencode-session", value: "{{sessionId}}" },
        { name: "x-static", value: "fixed" },
      ]),
    ).toEqual({ "x-static": "fixed" });
  });

  it("returns an empty map when the provider has no headers", () => {
    expect(builtinProviderHeaders(undefined)).toEqual({});
    expect(builtinProviderHeaders([])).toEqual({});
  });
});

describe("readSettingsSchema", () => {
  it("defaults to 1 when absent", () => {
    expect(readSettingsSchema({})).toBe(1);
    expect(readSettingsSchema(null)).toBe(1);
  });
});

describe("normalizeBuiltinSubagents", () => {
  it("defaults to the disabled feature with an empty roster", () => {
    expect(mergeClientAppSettings({}).builtinSubagents).toEqual({
      enabled: false,
      allowAdhoc: true,
      agents: [],
    });
    expect(DEFAULT_SETTINGS.builtinSubagents).toEqual({
      enabled: false,
      allowAdhoc: true,
      agents: [],
    });
  });

  it("keeps a valid user-defined agent and clamps maxTurns to the cap", () => {
    const merged = mergeClientAppSettings({
      builtinSubagents: {
        enabled: true,
        allowAdhoc: false,
        agents: [
          {
            id: "s1",
            name: "Test Runner",
            description: "Runs the test suite.",
            systemPrompt: "You run tests.",
            tools: ["read", "bash", "nonsense"],
            maxTurns: 999,
          },
        ],
      },
    }).builtinSubagents;
    expect(merged.enabled).toBe(true);
    expect(merged.allowAdhoc).toBe(false);
    expect(merged.agents).toEqual([
      {
        id: "s1",
        name: "test_runner",
        description: "Runs the test suite.",
        systemPrompt: "You run tests.",
        tools: ["read", "bash"],
        maxTurns: 60,
      },
    ]);
  });

  it("drops malformed rows and dedupes ids/names, reserving task and explore", () => {
    const merged = mergeClientAppSettings({
      builtinSubagents: {
        agents: [
          { id: "a", name: "explore", tools: ["read"] },
          { id: "b", name: "task", tools: ["read"] },
          { id: "c", name: "worker", tools: ["read"] },
          { id: "c", name: "worker2", tools: ["read"] },
          { id: "d", name: "worker", tools: ["read"] },
          { name: "no-id", tools: [] },
          null,
          "junk",
        ],
      },
    }).builtinSubagents;
    expect(merged.agents.map((a) => a.id)).toEqual(["c"]);
    expect(merged.agents[0]?.name).toBe("worker");
  });

  it("recovers the feature when the stored value is garbage", () => {
    expect(mergeClientAppSettings({ builtinSubagents: "junk" }).builtinSubagents).toEqual({
      enabled: false,
      allowAdhoc: true,
      agents: [],
    });
    expect(mergeClientAppSettings({ builtinSubagents: 42 }).builtinSubagents.enabled).toBe(false);
  });
});
