import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  isGenericToolTitle,
  isModelAccessError,
  isTokenizerEncodingError,
  tokenizerEncodingErrorHint,
  isSubagentToolCall,
  mapEffortParamValue,
  migrateModelParamValues,
  modelDisplayName,
  modelParamFamily,
  modelParamLabel,
  modelParamSectionName,
  parseModelWire,
  resolveModelParamValue,
  toolDisplayTitle,
  estimateContextUsage,
  extractSubagentLiveContent,
  effectiveMcpServers,
  expandMcpVars,
  normalizeMcpProjectFiles,
  normalizeSkillPaths,
  parseMcpProjectFile,
  isMcpServerAttached,
  mcpFolderConfig,
  mcpServerEndpoint,
  mcpServersFingerprint,
  mcpCommandNeedsAbsolute,
  mcpStdioEnv,
  canonicalCwd,
  toAcpMcpServer,
  boardColumn,
} from "@acpio/shared";

describe("parseModelWire", () => {
  it.each([
    ["", { base: "", params: {} }],
    ["grok-4.5", { base: "grok-4.5", params: {} }],
    ["grok-4.5[fast=true]", { base: "grok-4.5", params: { fast: "true" } }],
    [
      "grok-4.5[fast=true,reasoning=high]",
      { base: "grok-4.5", params: { fast: "true", reasoning: "high" } },
    ],
    ["grok-4.5[]", { base: "grok-4.5", params: {} }],
    ["grok-4.5[reasoning=extra-high]", { base: "grok-4.5", params: { reasoning: "extra-high" } }],
    ["grok-4.5[fast=true,]", { base: "grok-4.5", params: { fast: "true" } }],
    ["grok-4.5[=x]", { base: "grok-4.5", params: {} }],
    ["grok-4.5[fast=]", { base: "grok-4.5", params: { fast: "" } }],
    ["grok-4.5[size=128k=extra]", { base: "grok-4.5", params: { size: "128k=extra" } }],
    ["  grok-4.5  ", { base: "grok-4.5", params: {} }],
    ["grok-4.5 [ fast = true ]", { base: "grok-4.5", params: { fast: "true" } }],
    ["grok[FAST=true]", { base: "grok", params: { FAST: "true" } }],
    ["grok[fast=true][x=y]", { base: "grok[fast=true][x=y]", params: {} }],
    ["grok[my key=x]", { base: "grok", params: { "my key": "x" } }],
  ])("parseModelWire(%j)", (wire, expected) => {
    expect(parseModelWire(wire)).toEqual(expected);
  });
});

describe("modelDisplayName", () => {
  it.each([
    // empty / default / auto values collapse to the default label
    ["", undefined, undefined, "Default"],
    ["   ", undefined, undefined, "Default"],
    ["default", undefined, undefined, "Default"],
    ["default[]", undefined, undefined, "Default"],
    ["default[fast=true]", undefined, undefined, "Default"],
    ["auto", undefined, undefined, "Default"],
    ["AUTO", undefined, undefined, "Default"],
    ["Default", undefined, undefined, "Default"],
    ["", undefined, "Default model", "Default model"],
    ["auto", undefined, "Default model", "Default model"],
    // wire ids are prettified
    ["grok-4.5", undefined, undefined, "Grok 4.5"],
    ["grok-4.5[fast=true]", undefined, undefined, "Grok 4.5 · Fast"],
    ["grok-4.5[fast=true,reasoning=high]", undefined, undefined, "Grok 4.5 · Fast · High"],
    ["grok-4.5[fast=false]", undefined, undefined, "Grok 4.5"],
    ["claude[context=200k]", undefined, undefined, "Claude · 200K"],
    ["claude[reasoning=extra-high]", undefined, undefined, "Claude · Extra High"],
    ["gpt-4o[reasoning=high]", undefined, undefined, "GPT 4o · High"],
    ["claude-fast[fast=true]", undefined, undefined, "Claude Fast"],
    ["model[stream=true]", undefined, undefined, "Model · Stream"],
    ["model[temp=0.5]", undefined, undefined, "Model · Temp 0.5"],
    ["openai/grok-4.5", undefined, undefined, "Grok 4.5"],
    ["claude-3.7-sonnet", undefined, undefined, "Claude 3.7 Sonnet"],
    ["gpt-4o-mini", undefined, undefined, "GPT 4o Mini"],
    ["kimi-k2", undefined, undefined, "Kimi K2"],
    ["llama-70m", undefined, undefined, "Llama 70M"],
    // provided name wins when it is a clean human title
    ["grok-4.5", "Cursor Grok 4.5 Fast", undefined, "Cursor Grok 4.5 Fast"],
    ["", "Cursor Grok 4.5 Fast", undefined, "Cursor Grok 4.5 Fast"],
    ["", "My Grok", undefined, "My Grok"],
    ["", "Default Model", undefined, "Default Model"],
    // provided name that is a raw slug / has params is prettified instead
    ["", "grok-4.5", undefined, "Grok 4.5"],
    ["", "grok-4.5[fast=true]", undefined, "Grok 4.5 · Fast"],
    ["grok-4.5", "My Model[fast=true]", undefined, "Grok 4.5"],
    ["", "default", undefined, "Default"],
    ["", "auto", undefined, "Default"],
    ["", "default[]", undefined, "Default"],
    // an opaque agent id (ZCode's `[provider, model, variant]` tuple) is never
    // humanized wholesale: the agent's own title wins, and without one the tuple
    // still names its model part
    [
      '["builtin:zai-coding-plan","GLM-5.3-Flash",null]',
      "GLM-5.3-Flash",
      undefined,
      "GLM 5.3 Flash",
    ],
    [
      '["builtin:zai-coding-plan","GLM-5.3-Flash",null]',
      undefined,
      undefined,
      "GLM 5.3 Flash",
    ],
    // a built-in composite `<provider id>::<model id>` never shows the internal
    // provider id: the catalog name wins, and without one the model part is used
    ["pmuuvdc2xm3dz::deepseek-v4.1-flash", "Deepseek V4.1 Flash", undefined, "Deepseek V4.1 Flash"],
    ["pmuuvdc2xm3dz::deepseek-v4.1-flash", undefined, undefined, "Deepseek V4.1 Flash"],
    ["pmuuvdc2xm3dz::deepseek-v4.1-flash[fast=true]", undefined, undefined, "Deepseek V4.1 Flash · Fast"],
  ])("modelDisplayName(%j, %j, %j)", (value, name, defaultLabel, expected) => {
    expect(modelDisplayName(value, name, defaultLabel)).toBe(expected);
  });
});

describe("modelParamFamily", () => {
  it.each([
    ["fast", "fast"],
    ["FAST", "fast"],
    [" fast ", "fast"],
    ["Fast", "fast"],
    ["fast_mode", "fast"],
    ["effort", "effort"],
    ["Effort", "effort"],
    ["reasoning", "effort"],
    ["thinking", "effort"],
    ["thought_level", "effort"],
    ["reasoning_effort", "effort"],
    ["context", "context"],
    ["context_size", "context"],
    ["stream", null],
    ["", null],
    ["unknown", null],
  ])("modelParamFamily(%j)", (id, expected) => {
    expect(modelParamFamily(id)).toBe(expected);
  });
});

describe("mapEffortParamValue", () => {
  it.each([
    ["", undefined, ""],
    ["   ", undefined, ""],
    ["high", undefined, "high"],
    ["high", ["low", "high", "max"], "high"],
    ["High", ["low", "high", "max"], "high"],
    ["HIGH", ["high"], "high"],
    ["med", ["low", "medium", "max"], "medium"],
    ["off", ["none", "high"], "none"],
    ["xhigh", ["extra-high"], "extra-high"],
    ["extrahigh", ["xhigh"], "xhigh"],
    ["none", ["off"], "off"],
    ["0", ["none"], "none"],
    ["false", ["none"], "none"],
    ["med", ["med"], "med"],
    ["extra-high", ["extra-high", "high"], "extra-high"],
    ["unknown", ["low", "high"], ""],
    ["high", [], "high"],
  ])("mapEffortParamValue(%j, %j)", (value, allowed, expected) => {
    expect(mapEffortParamValue(value, allowed)).toBe(expected);
  });
});

describe("resolveModelParamValue", () => {
  it.each([
    // direct hit on the option id
    ["fast", { fast: "true" }, undefined, "true"],
    // direct empty value does not count; falls back to family scan
    ["fast", { fast: "" }, undefined, undefined],
    ["stream", { stream: "true" }, undefined, "true"],
    ["stream", {}, undefined, undefined],
    ["context", { context: "200k" }, undefined, "200k"],
    // effort direct values go through mapEffortParamValue
    ["effort", { effort: "med" }, ["low", "medium", "high"], "medium"],
    ["effort", { effort: "extreme" }, ["low", "high"], ""],
    // family fallback re-maps aliases onto the exposed option id
    ["reasoning", { effort: "high" }, undefined, "high"],
    ["reasoning", { effort: "med" }, ["low", "medium"], "medium"],
    ["reasoning", { effort: "" }, undefined, undefined],
    ["reasoning", {}, undefined, undefined],
    ["fast", { fast_mode: "true" }, undefined, "true"],
    ["context_size", { context: "200k" }, undefined, "200k"],
    // first family match wins
    ["fast", { fast_mode: "true", context: "200k" }, undefined, "true"],
    // unknown option id without a direct value resolves nothing
    ["bogus", { effort: "high" }, undefined, undefined],
  ])("resolveModelParamValue(%j, %j, %j)", (optId, params, allowed, expected) => {
    expect(resolveModelParamValue(optId, params, allowed)).toBe(expected);
  });
});

describe("migrateModelParamValues", () => {
  it.each([
    // effort -> reasoning re-key
    [
      { effort: "high" },
      [{ id: "reasoning", options: [{ value: "low" }, { value: "high" }] }],
      { reasoning: "high" },
    ],
    // reasoning -> effort re-key with alias mapping
    [
      { reasoning: "med" },
      [{ id: "effort", options: [{ value: "medium" }] }],
      { effort: "medium" },
    ],
    // families the agent does not expose are dropped
    [{ stream: "true", fast: "false" }, [{ id: "reasoning", options: [{ value: "high" }] }], {}],
    [
      { effort: "high", context: "200k" },
      [{ id: "reasoning", options: [{ value: "low" }, { value: "high" }] }],
      { reasoning: "high" },
    ],
    // fast / context re-keying
    [{ fast: "true" }, [{ id: "fast_mode" }], { fast_mode: "true" }],
    [{ context: "200k" }, [{ id: "context_size" }], { context_size: "200k" }],
    // currentValue fallback when nothing maps
    [{}, [{ id: "effort", currentValue: "medium" }], { effort: "medium" }],
    // fallback kicks in when mapped value is not exposed
    [
      { effort: "extreme" },
      [{ id: "effort", options: [{ value: "low" }], currentValue: "high" }],
      { effort: "high" },
    ],
    // empty currentValue is not written
    [{}, [{ id: "effort", currentValue: "" }], {}],
    // no exposed options -> nothing
    [{ effort: "high" }, [], {}],
    // non-string currentValue is stringified
    [{}, [{ id: "effort", currentValue: 5 }], { effort: "5" }],
    // only exposed ids survive
    [
      { effort: "high" },
      [{ id: "effort" }, { id: "context" }],
      { effort: "high" },
    ],
  ])("migrateModelParamValues(%j, %j)", (params, exposed, expected) => {
    expect(migrateModelParamValues(params, exposed)).toEqual(expected);
  });
});

describe("isModelAccessError", () => {
  it.each([
    ["Insufficient balance", true],
    ["Insufficient Balance", true],
    ["insufficient balance", true],
    ["Insufficient balance in your account", true],
    ["CreditsError: not enough credits", true],
    ["insufficient credits", true],
    ["insufficientcredits", true],
    ["insufficient_credits", true],
    ["insufficient  credits", false],
    ["Payment required", true],
    ["billing issue", true],
    ["billing", true],
    ["BillingError", true],
    ["", false],
    ["model unavailable", false],
    ["rate limited", false],
    ["timeout", false],
  ])("isModelAccessError(%j)", (message, expected) => {
    expect(isModelAccessError(message)).toBe(expected);
  });
});

describe("isTokenizerEncodingError", () => {
  it.each([
    ['value `"DeepSeekV3"` does not match any variant of enum `Encoding`', true],
    ["Unknown encoding", true],
    ["unknown tokenizer for model", true],
    ["Internal error", false],
    ["timeout", false],
  ])("isTokenizerEncodingError(%j)", (message, expected) => {
    expect(isTokenizerEncodingError(message)).toBe(expected);
  });
});

describe("modelParamLabel", () => {
  it.each([
    // fast family
    ["fast", "true", undefined, undefined, "Fast"],
    ["fast", "1", undefined, undefined, "Fast"],
    ["fast", "yes", undefined, undefined, "Fast"],
    ["fast", "TRUE", undefined, undefined, "Fast"],
    ["fast", "false", undefined, undefined, "Not Fast"],
    ["fast", "0", undefined, undefined, "Not Fast"],
    ["fast", "no", undefined, undefined, "Not Fast"],
    ["fast", "maybe", undefined, undefined, "maybe"],
    ["fast_mode", "true", undefined, undefined, "Fast"],
    // effort family
    ["effort", "high", undefined, undefined, "High"],
    ["effort", "off", undefined, undefined, "None"],
    ["effort", "med", undefined, undefined, "Medium"],
    ["effort", "xhigh", undefined, undefined, "Extra High"],
    ["effort", "extra_high", undefined, undefined, "Extra High"],
    ["effort", "extra-high", undefined, undefined, "Extra High"],
    ["effort", "minimal", undefined, undefined, "Minimal"],
    ["effort", "default", undefined, undefined, "Default"],
    ["effort", "unknown", undefined, undefined, "Unknown"],
    ["effort", "", undefined, undefined, ""],
    ["reasoning", "off", undefined, undefined, "None"],
    // effort value falls back to a labeled name
    ["effort", "huge", "high", undefined, "High"],
    // family inferred from the name for unknown ids
    ["knob", "high", "Reasoning level", undefined, "High"],
    ["knob", "true", "Fast mode", undefined, "Fast"],
    ["knob", "200k", "Context window", undefined, "Context window"],
    // non-family params: name, then yes/no labels, then raw value
    ["stream", "true", "Streaming", undefined, "Streaming"],
    ["stream", "true", "true", undefined, "Yes"],
    ["stream", "true", undefined, { yes: "On", no: "Off" }, "On"],
    ["stream", "false", undefined, { yes: "On", no: "Off" }, "Off"],
    ["stream", "true", undefined, undefined, "Yes"],
    ["stream", "false", undefined, undefined, "No"],
    ["stream", "200k", undefined, undefined, "200k"],
  ])("modelParamLabel(%j, %j, %j, %j)", (paramId, value, name, labels, expected) => {
    expect(modelParamLabel(paramId, value, name, labels)).toBe(expected);
  });
});

describe("modelParamSectionName", () => {
  it.each([
    ["fast", undefined, "Fast"],
    ["fast_mode", undefined, "Fast"],
    ["fast", "Fast Mode", "Fast"],
    ["reasoning", undefined, "Effort"],
    ["thinking", undefined, "Effort"],
    ["effort", "Reasoning", "Effort"],
    ["reasoning_effort", undefined, "Effort"],
    ["context", undefined, "Context"],
    ["context", "Window", "Window"],
    ["context_size", undefined, "Context"],
    // family inferred from the name
    ["unknown", "Fast mode", "Fast"],
    ["unknown", "Effort level", "Effort"],
    // unknown ids: named section or the raw id
    ["unknown", "My Custom Section", "My Custom Section"],
    ["unknown", "fast", "Fast"],
    ["stream", undefined, "stream"],
    ["unknown", "  ", "unknown"],
  ])("modelParamSectionName(%j, %j)", (paramId, name, expected) => {
    expect(modelParamSectionName(paramId, name)).toBe(expected);
  });
});

describe("isSubagentToolCall", () => {
  it.each([
    ["task", true],
    ["Task", true],
    ["TASK", true],
    [" task ", true],
    ["subagent", true],
    ["explore", true],
    ["browser", true],
    // "generalPurpose" lives mixed-case in the set, but lookups are
    // lowercased, so no casing can ever match it
    ["generalPurpose", false],
    ["generalpurpose", false],
    ["GENERALPURPOSE", false],
    ["ci-investigator", true],
    ["bugbot", true],
    ["security-review", true],
    ["best-of-n", true],
    ["", false],
    ["read", false],
    ["agent", false],
    ["write", false],
    ["browser_navigate", false],
    ["best_of_n", false],
    ["general purpose", false],
  ])("isSubagentToolCall(%j)", (kind, expected) => {
    expect(isSubagentToolCall(kind)).toBe(expected);
  });
});

describe("isGenericToolTitle", () => {
  it.each([
    ["", true],
    ["  ", true],
    ["Tool", true],
    ["tool", true],
    ["task", true],
    ["subagent", true],
    ["субагент", true],
    ["агент", true],
    ["MCP: tool", true],
    ["mcp:tool", true],
    ["MCP : tool", true],
    ["Web Search", false],
    ["grep", false],
    ["Запуск двух сабагентов", false],
    ["mcp__intermech_grep", false],
  ])("isGenericToolTitle(%j) -> %s", (title, expected) => {
    expect(isGenericToolTitle(title)).toBe(expected);
  });
});

describe("toolDisplayTitle", () => {
  it.each([
    // meaningful agent title wins
    ["Web Search", "web_search", undefined, "Web Search"],
    ["Поиск в интернете", "web_search", undefined, "Поиск в интернете"],
    // generic placeholder falls back to the real tool name
    ["MCP: tool", "mcp__intermech_grep", undefined, "intermech_grep"],
    ["Tool", "bash", undefined, "bash"],
    ["", "read", undefined, "read"],
    // mcp__ transport prefix is stripped for display
    ["", "mcp__Intermech_web_search", undefined, "Intermech_web_search"],
    // nothing left → empty, callers use their own "Tool" label
    ["", "", undefined, ""],
    ["MCP: tool", "MCP: tool", undefined, ""],
    ["Tool", "task", undefined, ""],
    ["Task", undefined, undefined, ""],
    // Cursor sends no tool name for MCP tools — fall back to the call's subject
    ["Tool", undefined, { query: "AVS" }, "AVS"],
    ["MCP: tool", undefined, { searchText: "спецификации" }, "спецификации"],
    ["", undefined, { path: "C:/docs/ips" }, "C:/docs/ips"],
    ["", undefined, { query: "" }, ""],
  ])("toolDisplayTitle(%j, %j, %j) -> %j", (title, toolName, args, expected) => {
    expect(toolDisplayTitle(title, toolName, args)).toBe(expected);
  });
});

describe("DEFAULT_SETTINGS", () => {
  const expectedDefaults: Record<string, unknown> = {
    theme: "light",
    locale: "en",
    displayName: "",
    connectedProvider: null,
    defaultProvider: "cursor",
    disabledProviders: [],
    defaultMode: "agent",
    defaultCwd: "",
    defaultModel: "",
    defaultModelParams: {},
    defaultModelByProvider: {},
    defaultModelParamsByProvider: {},
    modelParamsByProviderModel: {},
    recentModelsByProvider: {},
    favoriteModelsByProvider: {},
    cursorCommand: "agent",
    cursorArgs: ["acp"],
    customAgents: [],
    ompCommand: "omp",
    ompArgs: ["acp"],
    cursorApiKey: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    builtinProviders: [],
    permissionPolicy: "always",
    permissionAllowlist: [],
    diagnosticsDir: "",
    diagnosticsDeepLogging: false,
    exportDir: "",
    resumeAgentContext: true,
    multitask: false,
    sidebarCollapse: "full",
    showBootSplash: true,
    fontFamily: "",
    fontSize: "",
    lightScheme: "",
    darkScheme: "",
    lightAccent: "",
    lightBg: "",
    lightSurface: "",
    darkAccent: "",
    darkBg: "",
    darkSurface: "",
    ttsVoiceGender: "",
    chatActions: ["copy", "edit", "like", "dislike", "share", "regenerate", "readAloud"],
    chatMetaChips: ["folder", "board", "gitBranch", "gitChanges", "thoughts", "mcp", "context", "console"],
    thoughtsChipStyle: "full",
    consoleChipStyle: "full",
    terminalShell: "cmd",
    chatComposerButtons: ["attach", "mic", "model", "mode"],
    attachDefaultSource: "device",
    chatTreeElements: ["search", "searchMsgs", "pin", "archive", "more"],
    chatTreeMenu: ["rename", "move", "export", "delete"],
    chatTreeShowArchive: true,
    chatTreeRecentLimit: 0,
    chatHeaderHeight: 52,
    chatHeaderIcons: ["lang", "install", "theme"],
    chatEnterToSend: true,
    chatShowMessageTime: false,
    chatAgentTurnTimeline: false,
    chatSplit: true,
    chatToolbarStyle: "classic",
    boardAddCardStyle: "card",
    boardTaskAgentPicker: true,
    chatGitBranchPosition: "below",
    chatChipOptions: {
      folder: { compress: true, truncate: "middle" },
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "linesAndFiles" },
      context: { format: "usage" },
    },
    remoteAccessKey: "",
    mcpServers: [],
    mcpFolderConfigs: {},
    mcpProjectFiles: [".omp/mcp.json", ".cursor/mcp.json", ".agents/mcp.json"],
    builtinSkillPaths: [".agents/skills"],
    composerDrafts: {},
  };

  it("contains every AppSettings key", () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(
      Object.keys(expectedDefaults).sort(),
    );
  });

  it.each(Object.entries(expectedDefaults))("defaults %s", (key, value) => {
    expect((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]).toEqual(value);
  });

  it("matches the full literal shape", () => {
    expect(DEFAULT_SETTINGS).toEqual(expectedDefaults);
  });
});

describe("estimateContextUsage", () => {
  const msg = (role: "user" | "assistant", parts: Array<{ type: string; payload?: Record<string, unknown> }>) => ({
    id: "m",
    sessionId: "s",
    role,
    createdAt: "",
    parts: parts.map((p, i) => ({ id: `p${i}`, messageId: "m", type: p.type, order: i, payload: p.payload ?? {}, createdAt: "" })),
  });

  it("counts text and thought characters", () => {
    const usage = estimateContextUsage([
      msg("user", [{ type: "text", payload: { text: "hello world" } }]),
      msg("assistant", [{ type: "thought", payload: { text: "thinking" } }, { type: "text", payload: { text: "reply" } }]),
    ]);
    // 11 + 8 + 5 = 24 chars → ceil(24/4) = 6 tokens
    expect(usage.chars).toBe(24);
    expect(usage.tokens).toBe(6);
  });

  it("extracts tool_call input and subagent result", () => {
    const usage = estimateContextUsage([
      msg("assistant", [
        { type: "tool_call", payload: { title: "Read", raw: { input: { path: "a.txt" } } } },
        { type: "subagent", payload: { prompt: "do thing", result: "done", raw: {} } },
      ]),
    ]);
    const text = JSON.stringify({ path: "a.txt" });
    // "Read" (4) + " " join + input json + "done" (result wins over prompt)
    expect(usage.chars).toBe(4 + 1 + text.length + 4);
    expect(usage.tokens).toBe(Math.ceil(usage.chars / 4));
  });

  it("returns zero for empty conversation", () => {
    expect(estimateContextUsage([])).toEqual({ chars: 0, tokens: 0 });
  });
});

describe("extractSubagentLiveContent", () => {
  it("splits thinking blocks from text content while a tool call is in progress", () => {
    expect(
      extractSubagentLiveContent({
        content: [
          { type: "thinking", thinking: "First I will sleep…" },
          { type: "content", content: { type: "text", text: "Waited 10s" } },
        ],
      }),
    ).toEqual({
      thinking: ["First I will sleep…"],
      result: "Waited 10s",
    });
  });

  it("collects multiple thinking blocks without dropping earlier ones", () => {
    const live = extractSubagentLiveContent({
      content: [
        { type: "reasoning", text: "step 1" },
        { type: "thought", thinking: "step 2" },
      ],
    });
    expect(live.thinking).toEqual(["step 1", "step 2"]);
    expect(live.result).toBe("");
  });
});

describe("MCP helpers", () => {
  const http = {
    id: "h",
    name: "http",
    enabled: true,
    type: "local" as const,
    url: "http://127.0.0.1:9",
  };
  const stdio = {
    id: "s",
    name: "fs",
    enabled: true,
    type: "stdio" as const,
    command: "npx",
    args: ["-y", "mcp-server"],
    envConfig: '{"API_KEY":"k"}',
  };

  it("treats stdio as attached when command is set, HTTP when url is set", () => {
    expect(isMcpServerAttached(http)).toBe(true);
    expect(isMcpServerAttached(stdio)).toBe(true);
    expect(isMcpServerAttached({ ...http, url: "  " })).toBe(false);
    expect(isMcpServerAttached({ ...stdio, command: "  " })).toBe(false);
    expect(isMcpServerAttached({ ...stdio, enabled: false })).toBe(false);
  });

  it("maps stdio to ACP without a type field", () => {
    expect(toAcpMcpServer(stdio)).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "mcp-server"],
      env: [{ name: "API_KEY", value: "k" }],
    });
  });

  it("maps HTTP to ACP type http", () => {
    expect(toAcpMcpServer(http)).toMatchObject({
      name: "http",
      type: "http",
      url: "http://127.0.0.1:9",
    });
  });

  it("parses envConfig object and env array", () => {
    expect(mcpStdioEnv(stdio)).toEqual([{ name: "API_KEY", value: "k" }]);
    expect(
      mcpStdioEnv({
        ...stdio,
        env: [{ name: "X", value: "1" }],
        envConfig: '{"API_KEY":"k"}',
      }),
    ).toEqual([{ name: "X", value: "1" }]);
  });

  it("fingerprints stdio command/args/env separately from HTTP url", () => {
    expect(mcpServerEndpoint(stdio)).toBe("npx -y mcp-server");
    const a = mcpServersFingerprint([stdio]);
    const b = mcpServersFingerprint([{ ...stdio, args: ["-y", "other"] }]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(mcpServersFingerprint([http]));
  });

  it("flags bare stdio commands that agents cannot resolve via PATH", () => {
    expect(mcpCommandNeedsAbsolute(stdio)).toBe(true);
    expect(mcpCommandNeedsAbsolute({ ...stdio, command: " C:/Tools/mcp.exe " })).toBe(false);
    expect(mcpCommandNeedsAbsolute({ ...stdio, command: "./bin/mcp" })).toBe(false);
    expect(mcpCommandNeedsAbsolute({ ...stdio, command: "\\\\server\\share\\mcp.exe" })).toBe(false);
    expect(mcpCommandNeedsAbsolute({ ...stdio, command: "" })).toBe(false);
    expect(mcpCommandNeedsAbsolute(http)).toBe(false);
  });
});

describe("effectiveMcpServers", () => {
  const mcp = (id: string, enabled = true) => ({
    id,
    name: id,
    enabled,
    type: "local" as const,
    url: `http://localhost/${id}`,
  });
  const folderServer = { ...mcp("own"), name: "own" };
  const base = {
    ...DEFAULT_SETTINGS,
    mcpServers: [mcp("a"), mcp("b"), mcp("c", false)],
  };

  it.each([
    ["no disabled ids → all enabled servers", undefined, ["a", "b"]],
    ["empty disabled list", [], ["a", "b"]],
    ["one disabled", ["a"], ["b"]],
    ["all disabled", ["a", "b"], []],
    ["unknown ids ignored", ["nope"], ["a", "b"]],
    ["disabled applies to disabled server too (no-op)", ["c"], ["a", "b"]],
  ] as const)("%s", (_name, disabledIds, expected) => {
    const result = effectiveMcpServers(base, disabledIds);
    expect(result.map((s) => s.id)).toEqual(expected);
  });

  it("filters by enabled and url regardless of disabled list", () => {
    const withEmptyUrl = { ...base, mcpServers: [{ ...mcp("x"), url: "  " }] };
    expect(effectiveMcpServers(withEmptyUrl, [])).toEqual([]);
  });

  it("includes enabled stdio servers that have a command", () => {
    const stdio = {
      id: "fs",
      name: "fs",
      enabled: true,
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "mcp"],
    };
    const mixed = {
      ...base,
      mcpServers: [mcp("a"), stdio, { ...stdio, id: "off", enabled: false }],
    };
    expect(effectiveMcpServers(mixed, [])).toEqual([mcp("a"), stdio]);
    expect(effectiveMcpServers(mixed, ["fs"]).map((s) => s.id)).toEqual(["a"]);
  });

  it("drops servers the folder switched off", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: { a: false }, servers: [] } },
    };
    expect(effectiveMcpServers(settings, undefined, "E:/proj").map((s) => s.id)).toEqual(["b"]);
    // An unrelated folder keeps the global list untouched.
    expect(effectiveMcpServers(settings, undefined, "E:/other").map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("attaches a server the folder switched on even though it is off globally", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: { c: true }, servers: [] } },
    };
    expect(effectiveMcpServers(settings, undefined, "E:/proj").map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(effectiveMcpServers(settings, undefined, "E:/other").map((s) => s.id)).toEqual([
      "a",
      "b",
    ]);
    // The chat's own switch still wins over the folder's.
    expect(effectiveMcpServers(settings, ["c"], "E:/proj").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("matches a folder regardless of slash style and trailing separators", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: { a: false }, servers: [] } },
    };
    expect(effectiveMcpServers(settings, undefined, "E:\\proj\\").map((s) => s.id)).toEqual(["b"]);
  });

  it("appends the folder's own servers after the globals", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: {
        "E:/proj": { overrides: {}, servers: [folderServer, { ...mcp("off", false) }] },
      },
    };
    expect(effectiveMcpServers(settings, undefined, "E:/proj").map((s) => s.id)).toEqual([
      "a",
      "b",
      "own",
    ]);
  });

  it("drops a folder server that has no usable endpoint", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: {
        "E:/proj": { overrides: {}, servers: [{ ...folderServer, url: "  " }] },
      },
    };
    expect(effectiveMcpServers(settings, undefined, "E:/proj").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("lets the chat disable a folder server, same as a global one", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: {}, servers: [folderServer] } },
    };
    expect(effectiveMcpServers(settings, ["own"], "E:/proj").map((s) => s.id)).toEqual(["a", "b"]);
    expect(effectiveMcpServers(settings, ["a"], "E:/proj").map((s) => s.id)).toEqual(["b", "own"]);
  });

  it("resolves a folder config only for a non-empty cwd", () => {
    const settings = {
      ...base,
      mcpFolderConfigs: { "": { overrides: { a: false }, servers: [folderServer] } },
    };
    expect(mcpFolderConfig(settings, "")).toBeUndefined();
    expect(mcpFolderConfig(settings, "  ")).toBeUndefined();
    expect(canonicalCwd("E:\\proj\\")).toBe("E:/proj");
    expect(canonicalCwd("C:\\")).toBe("C:/");
    expect(canonicalCwd("C:")).toBe("C:/");
    expect(canonicalCwd("/")).toBe("/");
    expect(canonicalCwd("")).toBe("");
  });

  it("appends servers from the folder's own MCP files", () => {
    const fileServer = { ...mcp("file:.omp/mcp.json:fs"), name: "fs" };
    expect(effectiveMcpServers(base, [], "E:/proj", [fileServer]).map((s) => s.id)).toEqual([
      "a",
      "b",
      "file:.omp/mcp.json:fs",
    ]);
    expect(effectiveMcpServers(base, [], "E:/proj", [fileServer, mcp("off", false)]).length).toBe(3);
  });

  it("keeps an app-configured server when a file reuses its name", () => {
    const shadow = { ...mcp("file:.cursor/mcp.json:a"), name: "a" };
    expect(effectiveMcpServers(base, [], "E:/proj", [shadow]).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("reserves the name of a server that is off globally", () => {
    const shadow = { ...mcp("file:.cursor/mcp.json:c"), name: "c" };
    expect(effectiveMcpServers(base, [], "E:/proj", [shadow]).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("lets the folder and the chat switch a file server by id", () => {
    const fileServer = { ...mcp("file:.omp/mcp.json:fs"), name: "fs" };
    const settings = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: {}, servers: [] } },
    };
    expect(effectiveMcpServers(settings, ["file:.omp/mcp.json:fs"], "E:/proj", [fileServer])).toEqual(
      effectiveMcpServers(base, [], "E:/proj"),
    );
    // Off in the file it came from, but this folder switches it on.
    const off = { ...fileServer, enabled: false };
    expect(effectiveMcpServers(base, [], "E:/proj", [off]).map((s) => s.id)).toEqual(["a", "b"]);
    const onForFolder = {
      ...base,
      mcpFolderConfigs: { "E:/proj": { overrides: { [off.id]: true }, servers: [] } },
    };
    expect(
      effectiveMcpServers(onForFolder, [], "E:/proj", [off]).map((s) => s.id),
    ).toEqual(["a", "b", "file:.omp/mcp.json:fs"]);
  });
});

describe("normalizeMcpProjectFiles", () => {
  it("falls back to the defaults for a missing setting", () => {
    expect(normalizeMcpProjectFiles(undefined)).toEqual([
      ".omp/mcp.json",
      ".cursor/mcp.json",
      ".agents/mcp.json",
    ]);
    expect(normalizeMcpProjectFiles("nope")).toEqual([".omp/mcp.json", ".cursor/mcp.json", ".agents/mcp.json"]);
  });

  it("keeps an explicitly empty list empty", () => {
    expect(normalizeMcpProjectFiles([])).toEqual([]);
  });

  it("trims, slashes and de-duplicates entries", () => {
    expect(normalizeMcpProjectFiles([" .cursor\\mcp.json ", "./.cursor/mcp.json"])).toEqual([
      ".cursor/mcp.json",
    ]);
    expect(normalizeMcpProjectFiles([".omp//mcp.json"])).toEqual([".omp/mcp.json"]);
  });

  it("drops absolute paths and paths escaping the folder", () => {
    expect(normalizeMcpProjectFiles(["C:/other/mcp.json"])).toEqual([]);
    expect(normalizeMcpProjectFiles(["/etc/mcp.json"])).toEqual([]);
    expect(normalizeMcpProjectFiles(["../outside/mcp.json"])).toEqual([]);
    expect(normalizeMcpProjectFiles([".config/../mcp.json"])).toEqual([]);
    expect(normalizeMcpProjectFiles(["", "   ", 7])).toEqual([]);
  });
});

describe("normalizeSkillPaths", () => {
  it("falls back to the default folder for a missing setting", () => {
    expect(normalizeSkillPaths(undefined)).toEqual([".agents/skills"]);
    expect(normalizeSkillPaths("nope")).toEqual([".agents/skills"]);
  });

  it("keeps an explicitly empty list empty", () => {
    expect(normalizeSkillPaths([])).toEqual([]);
  });

  it("trims, slashes and de-duplicates entries", () => {
    expect(normalizeSkillPaths([" .agents\\skills ", "./.agents/skills"])).toEqual([
      ".agents/skills",
    ]);
    expect(normalizeSkillPaths([".agents//skills/"])).toEqual([".agents/skills"]);
  });

  it("keeps absolute paths — they name global collections", () => {
    expect(normalizeSkillPaths(["C:/Users/me/.agents/skills"])).toEqual([
      "C:/Users/me/.agents/skills",
    ]);
    expect(normalizeSkillPaths(["/etc/skills"])).toEqual(["/etc/skills"]);
  });

  it("keeps home-relative ~ paths", () => {
    expect(normalizeSkillPaths(["~/.agents/skills"])).toEqual(["~/.agents/skills"]);
    expect(normalizeSkillPaths([" ~\\skills "])).toEqual(["~/skills"]);
    expect(normalizeSkillPaths(["~"])).toEqual(["~"]);
  });

  it("drops relative paths escaping the folder and junk entries", () => {
    expect(normalizeSkillPaths(["../outside/skills"])).toEqual([]);
    expect(normalizeSkillPaths([".config/../skills"])).toEqual([]);
    expect(normalizeSkillPaths(["", "   ", 7])).toEqual([]);
  });
});

describe("parseMcpProjectFile", () => {
  it("parses stdio and http entries", () => {
    const result = parseMcpProjectFile(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "mcp-fs"], env: { TOKEN: "abc" } },
          gitea: {
            url: "https://gitea.example/mcp",
            headers: { Authorization: "Bearer abc" },
          },
        },
      }),
      ".omp/mcp.json",
    );
    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      {
        id: "file:.omp/mcp.json:fs",
        name: "fs",
        enabled: true,
        type: "stdio",
        command: "npx",
        args: ["-y", "mcp-fs"],
        env: [{ name: "TOKEN", value: "abc" }],
      },
      {
        id: "file:.omp/mcp.json:gitea",
        name: "gitea",
        enabled: true,
        type: "remote",
        url: "https://gitea.example/mcp",
        remoteConfig: JSON.stringify({ headers: { Authorization: "Bearer abc" } }),
      },
    ]);
  });

  it("keeps disabled entries as disabled", () => {
    const result = parseMcpProjectFile(
      '{"mcpServers":{"fs":{"command":"npx","enabled":false}}}',
      "mcp.json",
    );
    expect(result.servers[0].enabled).toBe(false);
  });

  it("expands environment placeholders and leaves unresolved ones literal", () => {
    const result = parseMcpProjectFile(
      JSON.stringify({
        mcpServers: {
          fs: { command: "${MCP_BIN}", env: { A: "${TOKEN}", B: "${MISSING:-fallback}" } },
        },
      }),
      "mcp.json",
      { MCP_BIN: "C:/Tools/mcp.exe", TOKEN: "secret" },
    );
    expect(result.servers[0].command).toBe("C:/Tools/mcp.exe");
    expect(result.servers[0].env).toEqual([
      { name: "A", value: "secret" },
      { name: "B", value: "fallback" },
    ]);
    expect(expandMcpVars("${NOPE}", {})).toBe("${NOPE}");
    expect(expandMcpVars("${EMPTY}", { EMPTY: "" })).toBe("${EMPTY}");
  });

  it("warns instead of failing on malformed files and entries", () => {
    expect(parseMcpProjectFile("{oops", "mcp.json").warnings).toEqual([
      "mcp.json: invalid JSON",
    ]);
    expect(parseMcpProjectFile("[]", "mcp.json").warnings).toEqual([
      "mcp.json: not a JSON object",
    ]);
    expect(parseMcpProjectFile('{"servers":{}}', "mcp.json").warnings).toEqual([
      'mcp.json: missing "mcpServers" object',
    ]);
    const mixed = parseMcpProjectFile(
      JSON.stringify({
        mcpServers: {
          bad: "nope",
          empty: {},
          both: { command: "x", url: "https://x" },
          ok: { command: "x" },
        },
      }),
      "mcp.json",
    );
    expect(mixed.warnings).toEqual([
      'mcp.json: server "bad" is not an object',
      'mcp.json: server "empty" has neither "command" nor "url"',
      'mcp.json: server "both" sets both "command" and "url"',
    ]);
    expect(mixed.servers.map((s) => s.id)).toEqual(["file:mcp.json:ok"]);
  });

  it("flags an sse url, which is sent as http", () => {
    const result = parseMcpProjectFile(
      '{"mcpServers":{"gh":{"type":"sse","url":"https://x/sse"}}}',
      "mcp.json",
    );
    expect(result.warnings).toEqual(['mcp.json: server "gh": sse is sent as http']);
    expect(result.servers[0].type).toBe("remote");
  });
});

describe("boardColumn", () => {
  it("places a task by what the session row says", () => {
    const at = "2026-09-22T10:00:00.000Z";
    expect(boardColumn({ status: "idle", startedAt: null, doneAt: null })).toBe("todo");
    expect(boardColumn({ status: "running", startedAt: at, doneAt: null })).toBe("progress");
    expect(boardColumn({ status: "idle", startedAt: at, doneAt: null })).toBe("wait");
    expect(boardColumn({ status: "waiting", startedAt: at, doneAt: null })).toBe("wait");
    expect(boardColumn({ status: "error", startedAt: at, doneAt: null })).toBe("wait");
    expect(boardColumn({ status: "closed", startedAt: at, doneAt: null })).toBe("wait");
  });

  it("keeps a finished task in Done even while a turn is live", () => {
    expect(
      boardColumn({
        status: "running",
        startedAt: "2026-09-22T10:00:00.000Z",
        doneAt: "2026-09-22T11:00:00.000Z",
      }),
    ).toBe("done");
  });
});
