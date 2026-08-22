import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  isGenericToolTitle,
  isModelAccessError,
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
} from "@acprocess/shared";

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
    locale: "ru",
    displayName: "",
    connectedProvider: null,
    defaultProvider: "cursor",
    defaultMode: "agent",
    defaultCwd: "",
    defaultModel: "",
    defaultModelParams: {},
    defaultModelByProvider: {},
    defaultModelParamsByProvider: {},
    cursorCommand: "agent",
    cursorArgs: ["acp"],
    ompCommand: "omp",
    ompArgs: ["acp"],
    cursorApiKey: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    permissionPolicy: "always",
    permissionAllowlist: [],
    diagnosticsDir: "",
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
    chatMetaChips: ["folder", "thoughts", "mcp", "context"],
    chatComposerButtons: ["attach", "mic", "model", "mode"],
    chatTreeElements: ["search", "searchMsgs", "pin", "archive", "more"],
    chatTreeMenu: ["rename", "move", "export", "delete"],
    chatTreeShowArchive: true,
    chatHeaderHeight: 52,
    chatHeaderIcons: ["lang", "install", "theme"],
    chatEnterToSend: true,
    chatShowMessageTime: false,
    chatSplit: true,
    remoteAccessKey: "",
    mcpServers: [],
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
