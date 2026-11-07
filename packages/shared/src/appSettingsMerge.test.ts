import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  builtinProviderHeaders,
  builtinProviderKeys,
  hasBuiltinProviderLimits,
  normalizeBuiltinProviderKind,
  normalizeBuiltinProviders,
} from "./index.js";
import {
  BUILTIN_BASH_TIMEOUT_SEC_MAX,
  BUILTIN_BASH_TIMEOUT_SEC_MIN,
  BUILTIN_EXTRA_INSTRUCTIONS_MAX,
  BUILTIN_MAX_OUTPUT_TOKENS_MAX,
  BUILTIN_THINKING_LIMIT_MAX,
  CHAT_TREE_RECENT_LIMIT_MAX,
  SETTINGS_SCHEMA_VERSION,
  mergeClientAppSettings,
  normalizeBuiltinBashTimeoutSec,
  normalizeBuiltinExtraInstructions,
  normalizeChatAgentTurnTimeline,
  normalizeChatMetaChips,
  normalizeChatTreeMenu,
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
      "mcp",
      "context",
      "console",
      "bgJobs",
    ]);
  });

  it("adds console for legacy settings without it", () => {
    const chips = ["folder", "thoughts", "mcp", "context"];
    expect(normalizeChatMetaChips(chips, 1)).toEqual([
      "folder",
      "board",
      "gitBranch",
      "gitChanges",
      "mcp",
      "context",
      "console",
      "bgJobs",
    ]);
  });

  it("adds board after folder for settings saved before the board chip", () => {
    const chips = ["folder", "gitBranch", "gitChanges", "thoughts", "mcp", "context", "console"];
    expect(normalizeChatMetaChips(chips, 5)).toEqual([
      "folder",
      "board",
      "gitBranch",
      "gitChanges",
      "mcp",
      "context",
      "console",
      "bgJobs",
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
      "bgJobs",
    ]);
  });

  // The "Размышления" chip left the default row with schema 9 (the turn
  // timeline draws the reasoning in place): a list saved before it gives the
  // chip up once, and a list saved after it keeps whatever it has.
  it("drops the thoughts chip from settings saved before the timeline", () => {
    expect(normalizeChatMetaChips(["folder", "thoughts", "console"], 8)).toEqual([
      "folder",
      "console",
    ]);
    expect(normalizeChatMetaChips(["folder", "thoughts", "console"], 9)).toEqual([
      "folder",
      "thoughts",
      "console",
    ]);
  });

  it("falls back to the shipped row without the thoughts chip", () => {
    expect(normalizeChatMetaChips(undefined, 9)).toEqual(DEFAULT_SETTINGS.chatMetaChips);
    expect(DEFAULT_SETTINGS.chatMetaChips).not.toContain("thoughts");
  });

  // The background-task chip is the newest default: settings saved before it
  // pick it up at the end of their list, and a list that already has it keeps
  // its place.
  it("appends the background-task chip to settings saved before it", () => {
    expect(normalizeChatMetaChips(["folder", "console"], 6)).toEqual([
      "folder",
      "console",
      "bgJobs",
    ]);
    expect(normalizeChatMetaChips(["bgJobs", "folder"], 6)).toEqual(["bgJobs", "folder"]);
  });
});

describe("normalizeChatAgentTurnTimeline", () => {
  // The timeline is the default reading of a turn from schema 9 on. A stored
  // `false` is the old default, not a choice, so an older save is flipped once;
  // after that the switch owns the value.
  it("turns the timeline on for settings saved before it was the default", () => {
    expect(normalizeChatAgentTurnTimeline(false, 8)).toBe(true);
    expect(normalizeChatAgentTurnTimeline(undefined, 8)).toBe(true);
  });

  it("keeps the stored value once the schema is current", () => {
    expect(normalizeChatAgentTurnTimeline(false, 9)).toBe(false);
    expect(normalizeChatAgentTurnTimeline(true, 9)).toBe(true);
    expect(normalizeChatAgentTurnTimeline("yes", 9)).toBe(false);
  });

  it("carries the new default through the client merge", () => {
    expect(mergeClientAppSettings({}).chatAgentTurnTimeline).toBe(true);
    expect(
      mergeClientAppSettings({ settingsSchema: 9, chatAgentTurnTimeline: false })
        .chatAgentTurnTimeline,
    ).toBe(false);
  });
});

describe("normalizeChatTreeMenu", () => {
  // "share" joined the tree menu's commands with schema 8: a list saved
  // before it opens with it, where the default keeps it.
  it("adds share to settings saved before it", () => {
    expect(normalizeChatTreeMenu(["rename", "move", "export", "delete"], 7)).toEqual([
      "rename",
      "move",
      "export",
      "share",
      "delete",
    ]);
    expect(normalizeChatTreeMenu(["rename"], 7)).toEqual(["rename", "share"]);
  });

  it("keeps a current list as it is", () => {
    expect(normalizeChatTreeMenu(["rename", "delete", "share"], 8)).toEqual([
      "rename",
      "delete",
      "share",
    ]);
  });

  // Emptying the list hides the row's "⋯" button on purpose.
  it("leaves an emptied list empty", () => {
    expect(normalizeChatTreeMenu([], 7)).toEqual([]);
  });

  it("drops unknown ids and duplicates", () => {
    expect(normalizeChatTreeMenu(["rename", "nope", "rename", 7], 8)).toEqual(["rename"]);
    expect(normalizeChatTreeMenu(undefined, 8)).toEqual(DEFAULT_SETTINGS.chatTreeMenu);
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

  it("migrates the tree menu for a payload saved before share", () => {
    const merged = mergeClientAppSettings({ chatTreeMenu: ["rename", "export", "delete"] });
    expect(merged.chatTreeMenu).toEqual(["rename", "export", "share", "delete"]);
    expect(merged.settingsSchema).toBe(SETTINGS_SCHEMA_VERSION);
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

  it("keeps the built-in MCP switch list and heals a malformed one", () => {
    expect(mergeClientAppSettings({}).mcpBuiltinDisabledIds).toEqual([]);
    expect(
      mergeClientAppSettings({ mcpBuiltinDisabledIds: ["builtin:acpio_bg"] }).mcpBuiltinDisabledIds,
    ).toEqual(["builtin:acpio_bg"]);
    expect(mergeClientAppSettings({ mcpBuiltinDisabledIds: "nope" }).mcpBuiltinDisabledIds).toEqual(
      [],
    );
    expect(
      mergeClientAppSettings({ mcpBuiltinDisabledIds: ["ok", 7, null] }).mcpBuiltinDisabledIds,
    ).toEqual(["ok"]);
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

  it("heals the built-in agent's output ceiling", () => {
    expect(mergeClientAppSettings({}).builtinMaxOutputTokens).toBe(
      DEFAULT_SETTINGS.builtinMaxOutputTokens,
    );
    expect(mergeClientAppSettings({ builtinMaxOutputTokens: 9_999 }).builtinMaxOutputTokens).toBe(
      9_999,
    );
    expect(mergeClientAppSettings({ builtinMaxOutputTokens: 0 }).builtinMaxOutputTokens).toBe(0);
    expect(mergeClientAppSettings({ builtinMaxOutputTokens: -5 }).builtinMaxOutputTokens).toBe(0);
    expect(mergeClientAppSettings({ builtinMaxOutputTokens: 12.6 }).builtinMaxOutputTokens).toBe(13);
    expect(mergeClientAppSettings({ builtinMaxOutputTokens: 9e9 }).builtinMaxOutputTokens).toBe(
      BUILTIN_MAX_OUTPUT_TOKENS_MAX,
    );
    expect(
      mergeClientAppSettings({ builtinMaxOutputTokens: "many" }).builtinMaxOutputTokens,
    ).toBe(DEFAULT_SETTINGS.builtinMaxOutputTokens);
  });

  it("heals the mid-think fuse cap", () => {
    expect(mergeClientAppSettings({}).builtinThinkingLimit).toBe(
      DEFAULT_SETTINGS.builtinThinkingLimit,
    );
    expect(mergeClientAppSettings({ builtinThinkingLimit: 4_000 }).builtinThinkingLimit).toBe(
      4_000,
    );
    // 0 stays "off", negatives clamp to it, junk falls back to the default.
    expect(mergeClientAppSettings({ builtinThinkingLimit: -7 }).builtinThinkingLimit).toBe(0);
    expect(mergeClientAppSettings({ builtinThinkingLimit: 12.6 }).builtinThinkingLimit).toBe(13);
    expect(mergeClientAppSettings({ builtinThinkingLimit: 9e9 }).builtinThinkingLimit).toBe(
      BUILTIN_THINKING_LIMIT_MAX,
    );
    expect(
      mergeClientAppSettings({ builtinThinkingLimit: "many" }).builtinThinkingLimit,
    ).toBe(DEFAULT_SETTINGS.builtinThinkingLimit);
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
        apiKeys: [],
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
        apiKeys: ["sk-test"],
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
      { id: "p1", name: "http://a/v1", url: "http://a/v1", apiKeys: [], models: [] },
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
        { id: "p2", name: "Bare", url: "http://a/v1", apiKeys: [], models: [] },
      ],
    };
    expect(normalizeBuiltinProviders(raw)).toEqual([
      {
        id: "p1",
        name: "OpenCode",
        url: "https://opencode.ai/v1",
        apiKeys: [],
        models: [],
        headers: [{ name: "x-opencode-session", value: "{{sessionId}}" }],
      },
      { id: "p2", name: "Bare", url: "http://a/v1", apiKeys: [], models: [] },
    ]);
  });
});

describe("normalizeBuiltinProviders: keys", () => {
  it("keeps a key list, its order and its mode", () => {
    const raw = {
      builtinProviders: [
        {
          id: "p1",
          name: "Pooled",
          url: "https://api.example/v1",
          apiKeys: [" sk-a ", "sk-b", "sk-a", "", 7],
          apiKeyMode: "exhausted",
          models: [],
        },
      ],
    };
    expect(normalizeBuiltinProviders(raw)[0]).toMatchObject({
      apiKeys: ["sk-a", "sk-b"],
      apiKeyMode: "exhausted",
    });
  });

  it("drops the default mode and an unknown one", () => {
    const rows = [
      { id: "a", url: "http://a/v1", apiKeys: ["k"], apiKeyMode: "rotate", models: [] },
      { id: "b", url: "http://b/v1", apiKeys: ["k"], apiKeyMode: "sometimes", models: [] },
    ];
    const [a, b] = normalizeBuiltinProviders({ builtinProviders: rows });
    expect("apiKeyMode" in a).toBe(false);
    expect("apiKeyMode" in b).toBe(false);
  });

  it("folds a legacy single key into the list and reads it back", () => {
    const [row] = normalizeBuiltinProviders({
      builtinProviders: [{ id: "p1", url: "http://a/v1", apiKey: "sk-old", models: [] }],
    });
    expect(row.apiKeys).toEqual(["sk-old"]);
    expect("apiKey" in row).toBe(false);
    // Whatever shape a row is in, the reader takes the list, then the legacy key.
    expect(builtinProviderKeys(row)).toEqual(["sk-old"]);
    expect(builtinProviderKeys({ apiKey: "sk-plugin" })).toEqual(["sk-plugin"]);
    expect(builtinProviderKeys({ apiKeys: ["sk-list"], apiKey: "sk-old" })).toEqual(["sk-list"]);
    expect(builtinProviderKeys({})).toEqual([]);
  });
});

describe("normalizeBuiltinProviders: kind", () => {
  it("keeps a known kind and stores nothing for the plain endpoint", () => {
    const [known, plain, unknown] = normalizeBuiltinProviders({
      builtinProviders: [
        { id: "a", name: "DeepSeek", url: "https://api.deepseek.com/v1", kind: "deepseek", models: [] },
        { id: "b", name: "Mine", url: "http://a/v1", kind: "other", models: [] },
        { id: "c", name: "Mystery", url: "http://b/v1", kind: "nonsense", models: [] },
      ],
    });
    expect(known.kind).toBe("deepseek");
    // An absent field already means "other", so the default is never written.
    expect("kind" in plain).toBe(false);
    expect("kind" in unknown).toBe(false);
  });

  it("reads a kind case-insensitively and falls back to other", () => {
    expect(normalizeBuiltinProviderKind(" OpenRouter ")).toBe("openrouter");
    expect(normalizeBuiltinProviderKind(undefined)).toBe("other");
    expect(normalizeBuiltinProviderKind(7)).toBe("other");
  });

  it("only a known kind can report limits", () => {
    expect(hasBuiltinProviderLimits("deepseek")).toBe(true);
    expect(hasBuiltinProviderLimits("opencode")).toBe(true);
    // The spend row hangs on this: an endpoint of an unknown kind has no API.
    expect(hasBuiltinProviderLimits("other")).toBe(false);
    expect(hasBuiltinProviderLimits(undefined)).toBe(false);
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

describe("normalizeBuiltinBashTimeoutSec", () => {
  it("defaults to a timeout that covers an ordinary command", () => {
    expect(DEFAULT_SETTINGS.builtinBashTimeoutSec).toBe(15);
    expect(normalizeBuiltinBashTimeoutSec(undefined)).toBe(15);
    expect(normalizeBuiltinBashTimeoutSec("30")).toBe(15);
    expect(normalizeBuiltinBashTimeoutSec(Number.NaN)).toBe(15);
  });

  it("clamps to the bounds the harness enforces", () => {
    expect(normalizeBuiltinBashTimeoutSec(1)).toBe(BUILTIN_BASH_TIMEOUT_SEC_MIN);
    expect(normalizeBuiltinBashTimeoutSec(-40)).toBe(BUILTIN_BASH_TIMEOUT_SEC_MIN);
    expect(normalizeBuiltinBashTimeoutSec(9_000)).toBe(BUILTIN_BASH_TIMEOUT_SEC_MAX);
    expect(normalizeBuiltinBashTimeoutSec(42.6)).toBe(43);
  });
});

describe("normalizeBuiltinExtraInstructions", () => {
  it("keeps a string, heals anything else to empty", () => {
    expect(normalizeBuiltinExtraInstructions("Think briefly.")).toBe("Think briefly.");
    expect(normalizeBuiltinExtraInstructions(undefined)).toBe("");
    expect(normalizeBuiltinExtraInstructions(42)).toBe("");
    expect(normalizeBuiltinExtraInstructions({ text: "hi" })).toBe("");
  });

  it("caps the appended instructions", () => {
    expect(normalizeBuiltinExtraInstructions("x".repeat(9_000)).length).toBe(
      BUILTIN_EXTRA_INSTRUCTIONS_MAX,
    );
  });

  it("merge uses the default when the payload omits the field", () => {
    expect(mergeClientAppSettings({}).builtinExtraInstructions).toBe("");
    expect(mergeClientAppSettings({ builtinExtraInstructions: 7 }).builtinExtraInstructions).toBe("");
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

  it("keeps the children's model and drops an empty or non-string one", () => {
    expect(
      mergeClientAppSettings({ builtinSubagents: { enabled: true, model: "  p1::m2  " } })
        .builtinSubagents,
    ).toEqual({ enabled: true, allowAdhoc: true, model: "p1::m2", agents: [] });
    // Absent IS the default: children inherit the session's current model.
    expect(mergeClientAppSettings({ builtinSubagents: { model: "" } }).builtinSubagents).toEqual({
      enabled: false,
      allowAdhoc: true,
      agents: [],
    });
    expect(mergeClientAppSettings({ builtinSubagents: { model: 42 } }).builtinSubagents).toEqual({
      enabled: false,
      allowAdhoc: true,
      agents: [],
    });
  });
});
