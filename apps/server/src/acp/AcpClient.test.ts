import { describe, it, expect } from "vitest";
import path from "node:path";
import { DEFAULT_SETTINGS, customAgentAdapter, type AcpUsage, type AgentMode, type AppSettings, type HarnessAdapter } from "@acpio/shared";
import { getAdapter } from "../adapters/registry.js";
import {
  AcpClient,
  splitInlineThinking,
  findModelConfigOption,
  findModeConfigOption,
  modesFromSessionState,
  listAgentModes,
  isSwitchableModeList,
  listModelParamOptions,
  mergeConfigOptions,
  resolveCommand,
  buildAgentEnv,
  type ConfigOption,
  type AgentModeOption,
} from "./AcpClient";

// NOTE: appendStreamText / extractText / contentBlockType / isThoughtContentType /
// normalizeConfigOptions / commandNotFoundHint are module-private (not exported),
// so per the assignment they are covered only where reachable through exported
// helpers (findModelConfigOption/findModeConfigOption rely on the same logic
// that normalizeConfigOptions provides at the class level).

const apiKeyEnvNames = ["CURSOR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("splitInlineThinking", () => {
  it.each([
    { name: "empty string", raw: "", thought: "", text: "" },
    { name: "undefined raw", raw: undefined as unknown as string, thought: "", text: "" },
    { name: "plain text without tags", raw: "Hello world", thought: "", text: "Hello world" },
    { name: "<think> block", raw: "<think>deep</think>", thought: "deep", text: "" },
    { name: "<thinking> block", raw: "<thinking>deep</thinking>", thought: "deep", text: "" },
    { name: "◁think▷ block", raw: "◁think▷deep◁/think▷", thought: "deep", text: "" },
    {
      name: "mixed tag kinds join with blank line",
      raw: "<think>a</think> text <thinking>b</thinking> tail",
      thought: "a\n\nb",
      text: " text  tail",
    },
    {
      name: "all three kinds",
      raw: "<think>1</think><thinking>2</thinking>◁think▷3◁/think▷",
      thought: "1\n\n2\n\n3",
      text: "",
    },
    { name: "multiple <think> blocks", raw: "<think>a</think><think>b</think>", thought: "a\n\nb", text: "" },
    { name: "body is trimmed", raw: "<think>  spaced  </think>", thought: "spaced", text: "" },
    { name: "empty body filtered out", raw: "<think></think>X", thought: "", text: "X" },
    { name: "whitespace-only body filtered out", raw: "<think>   </think>X", thought: "", text: "X" },
    { name: "case-insensitive tags", raw: "<THINK>x</THINK>", thought: "x", text: "" },
    { name: "mixed-case <Thinking> tags", raw: "<Thinking>x</Thinking>", thought: "x", text: "" },
    { name: "leading space after block preserved", raw: "<think>x</think> word", thought: "x", text: " word" },
    { name: "multi-line body kept verbatim", raw: "<think>line1\nline2</think>", thought: "line1\nline2", text: "" },
    { name: "unterminated tag left in text", raw: "<think>oops", thought: "", text: "<think>oops" },
    { name: "◁think▷ mixed with surrounding text", raw: "pre ◁think▷ t ◁/think▷ post", thought: "t", text: "pre  post" },
    { name: "whitespace-only raw unchanged", raw: "   ", thought: "", text: "   " },
  ])("$name", ({ raw, thought, text }) => {
    expect(splitInlineThinking(raw)).toEqual({ thought, text });
  });
});

describe("findModelConfigOption", () => {
  it.each([
    { name: "empty list", options: [] as ConfigOption[], expected: undefined },
    { name: "canonical id 'model'", options: [{ id: "model" }], expected: { id: "model" } },
    { name: "case-insensitive id fallback", options: [{ id: "MODEL" }], expected: { id: "MODEL" } },
    {
      name: "exact 'model' beats case variant",
      options: [{ id: "model" }, { id: "MODEL" }],
      expected: { id: "model" },
    },
    {
      name: "fast param with category model is not a model select",
      options: [{ id: "fast", category: "model", options: [{ value: "true", name: "Fast" }] }],
      expected: undefined,
    },
    {
      name: "effort-family param with category model is not a model select",
      options: [{ id: "reasoning", category: "model" }],
      expected: undefined,
    },
    {
      name: "thought_level with category model excluded",
      options: [{ id: "thought_level", category: "model" }],
      expected: undefined,
    },
    {
      name: "variant with category model excluded",
      options: [{ id: "variant", category: "model" }],
      expected: undefined,
    },
    {
      name: "unknown id with category model matches fallback",
      options: [{ id: "gpt-5", category: "model", options: [{ value: "gpt-5", name: "GPT-5" }] }],
      expected: { id: "gpt-5", category: "model", options: [{ value: "gpt-5", name: "GPT-5" }] },
    },
    {
      name: "effort under model_config category is not a model select",
      options: [{ id: "effort", category: "model_config" }],
      expected: undefined,
    },
    { name: "id 'model' wins regardless of category", options: [{ id: "model", category: "weird" }], expected: { id: "model", category: "weird" } },
  ])("$name", ({ options, expected }) => {
    expect(findModelConfigOption(options)).toEqual(expected);
  });
});

describe("findModeConfigOption", () => {
  it.each([
    { name: "empty list", options: [] as ConfigOption[], expected: undefined },
    { name: "id 'mode'", options: [{ id: "mode" }], expected: { id: "mode" } },
    { name: "id 'session_mode'", options: [{ id: "session_mode" }], expected: { id: "session_mode" } },
    { name: "category 'mode' fallback", options: [{ id: "custom", category: "mode" }], expected: { id: "custom", category: "mode" } },
    {
      name: "id 'mode' beats category fallback",
      options: [{ id: "mode" }, { id: "custom", category: "mode" }],
      expected: { id: "mode" },
    },
    {
      name: "id 'session_mode' beats category fallback",
      options: [{ id: "session_mode" }, { id: "custom", category: "mode" }],
      expected: { id: "session_mode" },
    },
    {
      name: "id 'mode' beats id 'session_mode'",
      options: [{ id: "mode" }, { id: "session_mode" }],
      expected: { id: "mode" },
    },
    {
      name: "model category is not a mode select",
      options: [{ id: "fast", category: "model" }],
      expected: undefined,
    },
  ])("$name", ({ options, expected }) => {
    expect(findModeConfigOption(options)).toEqual(expected);
  });
});

describe("listModelParamOptions", () => {
  it("returns [] for an empty option list", () => {
    expect(listModelParamOptions([])).toEqual([]);
  });

  it.each([
    {
      name: "skips model/mode/session_mode ids",
      options: [
        { id: "model", options: [{ value: "m", name: "M" }] },
        { id: "mode", options: [{ value: "agent", name: "Agent" }] },
        { id: "session_mode", options: [{ value: "x", name: "X" }] },
      ],
      expected: [],
    },
    {
      name: "excludes the model select itself and the id 'model'",
      options: [
        { id: "model", options: [{ value: "m", name: "M" }] },
        { id: "fast", type: "select", options: [{ value: "true", name: "Fast" }] },
      ],
      expected: [{ id: "fast", type: "select", options: [{ value: "true", name: "Fast" }] }],
    },
    {
      name: "ranks fast before effort before context before unknown",
      options: [
        { id: "effort", type: "select", options: [{ value: "low", name: "Low" }] },
        { id: "fast", type: "select", options: [{ value: "true", name: "Fast" }] },
        { id: "context", type: "select", options: [{ value: "8k", name: "8k" }] },
        { id: "alpha", category: "model_config", type: "select", options: [{ value: "1", name: "1" }] },
      ],
      expectedIds: ["fast", "effort", "context", "alpha"],
    },
    {
      name: "all effort-family aliases are recognized",
      options: ["effort", "reasoning", "thinking", "thought_level", "reasoning_effort"].map((id) => ({
        id,
        type: "select",
        options: [{ value: "low", name: "Low" }],
      })),
      expectedIds: ["effort", "reasoning", "reasoning_effort", "thinking", "thought_level"],
    },
    {
      name: "context-family ids recognized and sorted",
      options: [
        { id: "context_size", type: "select", options: [{ value: "16k", name: "16k" }] },
        { id: "context", type: "select", options: [{ value: "8k", name: "8k" }] },
      ],
      expectedIds: ["context", "context_size"],
    },
    {
      name: "boolean type counts as choices",
      options: [{ id: "fast", type: "boolean" }],
      expected: [{ id: "fast", type: "boolean" }],
    },
    {
      name: "no options and no type is excluded",
      options: [{ id: "fast" }],
      expected: [],
    },
    {
      name: "unknown select knob without category is excluded",
      options: [{ id: "temperature", type: "select", options: [{ value: "0.5", name: "T" }] }],
      expected: [],
    },
    {
      name: "unknown knob with number type is excluded",
      options: [{ id: "weird_knob", type: "number", options: [{ value: "1", name: "1" }] }],
      expected: [],
    },
    {
      name: "category thought_level makes an unknown id known",
      options: [{ id: "creativity", category: "thought_level", type: "select", options: [{ value: "low", name: "Low" }] }],
      expected: [{ id: "creativity", category: "thought_level", type: "select", options: [{ value: "low", name: "Low" }] }],
    },
    {
      name: "category model_config makes an unknown id known",
      options: [{ id: "max_tokens", category: "model_config", type: "select", options: [{ value: "8k", name: "8k" }] }],
      expected: [{ id: "max_tokens", category: "model_config", type: "select", options: [{ value: "8k", name: "8k" }] }],
    },
    {
      name: "id regex match (variant/context_window) counts as known",
      options: [
        { id: "variant", type: "select", options: [{ value: "v1", name: "V1" }] },
        { id: "context_window", options: [{ value: "16k", name: "16k" }] },
      ],
      expectedIds: ["context_window", "variant"],
    },
    {
      name: "alphabetical within the same rank",
      options: [
        { id: "beta", category: "model_config", type: "select", options: [{ value: "1", name: "1" }] },
        { id: "alpha", category: "model_config", type: "select", options: [{ value: "2", name: "2" }] },
      ],
      expectedIds: ["alpha", "beta"],
    },
    {
      name: "category mode is excluded even with choices",
      options: [{ id: "something", category: "mode", options: [{ value: "x", name: "X" }] }],
      expected: [],
    },
  ])("$name", ({ options, expected, expectedIds }) => {
    const result = listModelParamOptions(options);
    if (expectedIds) {
      expect(result.map((o) => o.id)).toEqual(expectedIds);
    } else {
      expect(result).toEqual(expected);
    }
  });
});

describe("mergeConfigOptions", () => {
  it("returns prev unchanged when next is empty", () => {
    const prev: ConfigOption[] = [{ id: "effort", type: "select", options: [{ value: "low", name: "Low" }] }];
    expect(mergeConfigOptions(prev, [])).toBe(prev);
  });

  it.each([
    {
      name: "keeps prior options when a select refresh returns empty choices",
      prev: [{ id: "effort", type: "select", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }],
      next: [{ id: "effort", type: "select", options: [] }],
      expected: [{ id: "effort", type: "select", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }],
    },
    {
      name: "keeps prior options when refresh omits the type field",
      prev: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
      next: [{ id: "effort", options: [] }],
      expected: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
    },
    {
      name: "restored option keeps the fresh fields (e.g. name)",
      prev: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
      next: [{ id: "effort", name: "Fresh name", options: [] }],
      expected: [{ id: "effort", name: "Fresh name", options: [{ value: "low", name: "Low" }] }],
    },
    {
      name: "never restores options for the model select",
      prev: [{ id: "model", options: [{ value: "m", name: "M" }] }],
      next: [{ id: "model", options: [] }],
      expected: [{ id: "model", options: [] }],
    },
    {
      name: "does not restore into a boolean-typed fresh option",
      prev: [{ id: "fast", options: [{ value: "true", name: "On" }] }],
      next: [{ id: "fast", type: "boolean", options: [] }],
      expected: [{ id: "fast", type: "boolean", options: [] }],
    },
    {
      name: "fresh options win when non-empty",
      prev: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
      next: [{ id: "effort", options: [{ value: "high", name: "High" }] }],
      expected: [{ id: "effort", options: [{ value: "high", name: "High" }] }],
    },
    {
      name: "prev-only options are dropped when absent from next",
      prev: [
        { id: "effort", options: [{ value: "low", name: "Low" }] },
        { id: "context", options: [{ value: "8k", name: "8k" }] },
      ],
      next: [{ id: "effort", options: [{ value: "high", name: "High" }] }],
      expected: [{ id: "effort", options: [{ value: "high", name: "High" }] }],
    },
    {
      name: "new options present only in next are kept",
      prev: [],
      next: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
      expected: [{ id: "effort", options: [{ value: "low", name: "Low" }] }],
    },
  ])("$name", ({ prev, next, expected }) => {
    expect(mergeConfigOptions(prev, next)).toEqual(expected);
  });
});

describe("modesFromSessionState", () => {
  it.each([
    { name: "undefined state", raw: undefined, expected: [] },
    { name: "null state", raw: null, expected: [] },
    { name: "non-object state", raw: "modes", expected: [] },
    { name: "empty object", raw: {}, expected: [] },
    { name: "availableModes is not an array", raw: { availableModes: "x" }, expected: [] },
    {
      name: "availableModes mapped to value/name",
      raw: { availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] },
      expected: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }],
    },
    {
      name: "falls back to the modes key",
      raw: { modes: [{ id: "plan", name: "Plan" }] },
      expected: [{ value: "plan", name: "Plan" }],
    },
    {
      name: "empty availableModes wins over modes fallback",
      raw: { availableModes: [], modes: [{ id: "plan", name: "Plan" }] },
      expected: [],
    },
    {
      name: "null availableModes falls back to modes",
      raw: { availableModes: null, modes: [{ id: "plan", name: "Plan" }] },
      expected: [{ value: "plan", name: "Plan" }],
    },
    {
      name: "value used when id is absent",
      raw: { availableModes: [{ value: "ask" }] },
      expected: [{ value: "ask", name: "ask" }],
    },
    {
      name: "name falls back to value",
      raw: { availableModes: [{ id: "ask" }] },
      expected: [{ value: "ask", name: "ask" }],
    },
    {
      name: "id wins over value",
      raw: { availableModes: [{ id: "agent", value: "zzz" }] },
      expected: [{ value: "agent", name: "agent" }],
    },
    {
      name: "values and names are trimmed",
      raw: { availableModes: [{ id: "  agent  ", name: "  Agent  " }] },
      expected: [{ value: "agent", name: "Agent" }],
    },
    {
      name: "blank id entries are skipped",
      raw: { availableModes: [{ id: "   " }, { id: "plan", name: "Plan" }] },
      expected: [{ value: "plan", name: "Plan" }],
    },
  ])("$name", ({ raw, expected }) => {
    expect(modesFromSessionState(raw)).toEqual(expected);
  });
});

describe("listAgentModes", () => {
  const modeOpt: ConfigOption = {
    id: "mode",
    options: [
      { value: "agent", name: "Agent" },
      { value: "plan", name: "Plan" },
    ],
  };
  const CURSOR_DEFAULTS = [
    { value: "agent", name: "Agent" },
    { value: "plan", name: "Plan" },
    { value: "ask", name: "Ask" },
  ];
  it.each([
    {
      name: "session modes win over configOptions",
      options: [modeOpt],
      defaultModes: CURSOR_DEFAULTS,
      sessionModes: [{ value: "x", name: "X" }],
      expected: [{ value: "x", name: "X" }],
    },
    {
      name: "empty session modes fall through to configOptions",
      options: [modeOpt],
      defaultModes: CURSOR_DEFAULTS,
      sessionModes: [],
      expected: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      name: "configOptions mode option mapped",
      options: [modeOpt],
      defaultModes: [],
      sessionModes: undefined,
      expected: [
        { value: "agent", name: "Agent" },
        { value: "plan", name: "Plan" },
      ],
    },
    {
      name: "name falls back to value when empty",
      options: [{ id: "mode", options: [{ value: "ask", name: "" }] }],
      defaultModes: [],
      expected: [{ value: "ask", name: "ask" }],
    },
    {
      name: "name is trimmed",
      options: [{ id: "mode", options: [{ value: "ask", name: "  Ask  " }] }],
      defaultModes: [],
      expected: [{ value: "ask", name: "Ask" }],
    },
    {
      name: "category mode option works",
      options: [{ id: "custom", category: "mode", options: [{ value: "agent", name: "Agent" }] }],
      defaultModes: [],
      expected: [{ value: "agent", name: "Agent" }],
    },
    {
      name: "session_mode id works",
      options: [{ id: "session_mode", options: [{ value: "plan", name: "Plan" }] }],
      defaultModes: [],
      expected: [{ value: "plan", name: "Plan" }],
    },
    {
      name: "adapter defaults (Cursor) when nothing else provides modes",
      options: [],
      defaultModes: CURSOR_DEFAULTS,
      expected: CURSOR_DEFAULTS,
    },
    {
      name: "no defaults (OMP) yield no modes without a switcher",
      options: [],
      defaultModes: [],
      expected: [],
    },
    {
      name: "mode option with empty choices falls through to adapter defaults",
      options: [{ id: "mode", options: [] }],
      defaultModes: CURSOR_DEFAULTS,
      expected: CURSOR_DEFAULTS,
    },
  ])("$name", ({ options, defaultModes, sessionModes, expected }) => {
    expect(listAgentModes(options, defaultModes, sessionModes)).toEqual(expected);
  });
});

describe("isSwitchableModeList", () => {
  const mode = (value: string): AgentModeOption => ({ value, name: value });

  it.each([
    { name: "empty list", modes: [] as AgentModeOption[], expected: false },
    { name: "single default", modes: [mode("default")], expected: false },
    { name: "single normal", modes: [mode("normal")], expected: false },
    { name: "single standard", modes: [mode("standard")], expected: false },
    { name: "case-insensitive lone default", modes: [{ value: "DEFAULT", name: "Default" }], expected: false },
    { name: "single real mode", modes: [mode("agent")], expected: false },
    { name: "two real modes", modes: [mode("agent"), mode("plan")], expected: true },
    { name: "two modes including default", modes: [mode("default"), mode("plan")], expected: true },
    { name: "three modes", modes: [mode("agent"), mode("plan"), mode("ask")], expected: true },
  ])("$name", ({ modes, expected }) => {
    expect(isSwitchableModeList(modes)).toBe(expected);
  });
});

describe("buildAgentEnv", () => {
  it.each([
    {
      name: "cursor API key is exported",
      settings: settingsWith({ cursorApiKey: "ck-123" }),
      expected: { CURSOR_API_KEY: "ck-123" },
    },
    {
      name: "anthropic API key is exported",
      settings: settingsWith({ anthropicApiKey: "sk-ant-1" }),
      expected: { ANTHROPIC_API_KEY: "sk-ant-1" },
    },
    {
      name: "openai API key is exported",
      settings: settingsWith({ openaiApiKey: "sk-456" }),
      expected: { OPENAI_API_KEY: "sk-456" },
    },
    {
      name: "all three keys exported together",
      settings: settingsWith({ cursorApiKey: "ck", anthropicApiKey: "ant", openaiApiKey: "oa" }),
      expected: { CURSOR_API_KEY: "ck", ANTHROPIC_API_KEY: "ant", OPENAI_API_KEY: "oa" },
    },
    {
      name: "no keys set leaves no API key env vars",
      settings: settingsWith({}),
      expected: {},
    },
    {
      name: "empty-string keys are not exported",
      settings: settingsWith({ cursorApiKey: "", anthropicApiKey: "", openaiApiKey: "" }),
      expected: {},
    },
  ])("$name", ({ settings, expected }) => {
    const env = buildAgentEnv(getAdapter("cursor"), settings);
    for (const key of apiKeyEnvNames) {
      if (key in expected) {
        expect(env[key]).toBe(expected[key as keyof typeof expected]);
      } else {
        expect(env[key]).toBeUndefined();
      }
    }
  });

  it("exports each provider's own API key env var", () => {
    const settings = settingsWith({ cursorApiKey: "ck", anthropicApiKey: "ant", openaiApiKey: "oa" });
    const cursorEnv = buildAgentEnv(getAdapter("cursor"), settings);
    const ompEnv = buildAgentEnv(getAdapter("omp"), settings);
    // Cursor's key is exported only for cursor; anthropic/openai keys are shared.
    expect(cursorEnv.CURSOR_API_KEY).toBe("ck");
    expect(ompEnv.CURSOR_API_KEY).toBeUndefined();
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      expect(ompEnv[key]).toBe(cursorEnv[key]);
    }
  });

  it("never contains undefined values", () => {
    const env = buildAgentEnv(getAdapter("cursor"), settingsWith({ cursorApiKey: "ck", openaiApiKey: "oa" }));
    for (const value of Object.values(env)) {
      expect(value).not.toBeUndefined();
    }
  });

  it("sets NO_COLOR and leaves PATH unchanged (rewriting PATH broke OMP /review)", () => {
    const env = buildAgentEnv(getAdapter("cursor"), settingsWith({}));
    expect(env.NO_COLOR).toBe("1");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("exports a user-defined agent's own env without touching other harnesses", () => {
    const custom = customAgentAdapter({
      id: "my-agent",
      label: "My Agent",
      command: "agent.exe",
      args: [],
      env: { AGENT_LOG: "info" },
    });
    const env = buildAgentEnv(custom, settingsWith({ openaiApiKey: "oa" }));
    expect(env.AGENT_LOG).toBe("info");
    expect(env.OPENAI_API_KEY).toBe("oa");
    expect(buildAgentEnv(getAdapter("omp"), settingsWith({})).AGENT_LOG).toBeUndefined();
  });
});

describe("resolveCommand", () => {
  // Only deterministic passthrough cases (no reliance on where.exe/which).
  it.each([
    { name: "absolute .exe path", command: "C:\\Tools\\agent.exe", expected: { cmd: "C:\\Tools\\agent.exe", shell: false } },
    { name: "absolute .cmd path runs via shell", command: "C:\\Tools\\agent.cmd", expected: { cmd: "C:\\Tools\\agent.cmd", shell: true } },
    { name: "absolute .bat path runs via shell", command: "C:\\Tools\\agent.bat", expected: { cmd: "C:\\Tools\\agent.bat", shell: true } },
    { name: "forward-slash absolute path", command: "C:/Tools/agent", expected: { cmd: "C:/Tools/agent", shell: false } },
    { name: "unix absolute path", command: "/usr/local/bin/agent", expected: { cmd: "/usr/local/bin/agent", shell: false } },
    { name: "relative path with slash", command: "./agent", expected: { cmd: "./agent", shell: false } },
    { name: "backslash path without extension", command: "..\\tools\\agent", expected: { cmd: "..\\tools\\agent", shell: false } },
    { name: "bare .exe command", command: "agent.exe", expected: { cmd: "agent.exe", shell: false } },
    { name: "bare .cmd command", command: "agent.cmd", expected: { cmd: "agent.cmd", shell: true } },
    { name: "extension match is case-insensitive", command: "AGENT.EXE", expected: { cmd: "AGENT.EXE", shell: false } },
    { name: "cmd inside forward-slash path", command: "C:/Tools/agent.cmd", expected: { cmd: "C:/Tools/agent.cmd", shell: true } },
  ])("$name", async ({ command, expected }) => {
    expect(await resolveCommand(command)).toEqual(expected);
  });
});

describe("ACP usage_update normalization", () => {
  const fakeAdapter = {
    id: "test",
    label: "Test",
    defaultModes: [],
    subagentToolKinds: [],
    apiKeyField: undefined,
    envApiKeyName: undefined,
    commandField: "command",
    argsField: "args",
    defaultCommand: "agent",
    defaultArgs: ["acp"],
    modelParamPrefix: "",
    cloudCatalog: false,
  } as unknown as HarnessAdapter;

  // `normalizeUsage`/`mapUpdate` are private class methods; expose them through a
  // single named cast so the test can drive the ACP ingestion path directly.
  type TestableAcp = AcpClient & {
    normalizeUsage: (r: Record<string, unknown>) => AcpUsage;
    mapUpdate: (u: Record<string, unknown>) => { kind: string; usage?: AcpUsage };
  };
  const makeClient = () =>
    new AcpClient(fakeAdapter, DEFAULT_SETTINGS, "/tmp", "agent" as AgentMode) as unknown as TestableAcp;

  it("maps canonical ACP usage_update used/size/cost", () => {
    const acp = makeClient();
    const result = acp.normalizeUsage({
      sessionUpdate: "usage_update",
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
    expect(result.usedTokens).toBe(53000);
    expect(result.contextWindow).toBe(200000);
    expect(result.cost).toBe(0.045);
  });

  it("falls back to alternate field spellings", () => {
    const acp = makeClient();
    const result = acp.normalizeUsage({ usedTokens: 5, contextWindow: 10 });
    expect(result.usedTokens).toBe(5);
    expect(result.contextWindow).toBe(10);
  });

  it("classifies usage_update as kind 'usage' via mapUpdate", () => {
    const acp = makeClient();
    const ev = acp.mapUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 });
    expect(ev.kind).toBe("usage");
    expect(ev.usage?.usedTokens).toBe(1);
    expect(ev.usage?.contextWindow).toBe(2);
  });
});

describe("applyModelSelection against an enumerated model list", () => {
  /** Opaque value a user-defined agent reports (JSON tuple, no params syntax). */
  const WIRE = '["builtin:zai-coding-plan","GLM-5.3-Flash",null]';

  type TestableModelAcp = AcpClient & {
    configOptions: ConfigOption[];
    setConfigOption: (id: string, value: string) => Promise<void>;
  };

  function makeClient(calls: Array<[string, string]>) {
    const acp = new AcpClient(
      customAgentAdapter({ id: "my-agent", label: "My Agent", command: "agent.exe", args: [] }),
      DEFAULT_SETTINGS,
      "/tmp",
      "agent" as AgentMode,
    ) as unknown as TestableModelAcp;
    acp.configOptions = [
      { id: "my-agent.model", category: "model", options: [{ value: WIRE, name: "Flash" }] },
    ];
    acp.setConfigOption = async (id, value) => {
      calls.push([id, value]);
    };
    return acp;
  }

  it("sends the exact value the agent listed", async () => {
    const calls: Array<[string, string]> = [];
    await makeClient(calls).applyModelSelection(WIRE);
    expect(calls).toEqual([["my-agent.model", WIRE]]);
  });

  it("skips a model this agent does not know instead of sending it", async () => {
    const calls: Array<[string, string]> = [];
    await makeClient(calls).applyModelSelection("builtin:bigmodel/GLM-5.3");
    expect(calls).toEqual([]);
  });
});