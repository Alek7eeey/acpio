import { describe, it, expect } from "vitest";
import {
  CUSTOM_AGENT_MAX,
  customAgentAdapter,
  normalizeCustomAgentId,
  normalizeCustomAgents,
} from "./adapters.js";

const base = { id: "my-agent", label: "My Agent", command: "C:\\tools\\agent.exe" };

describe("normalizeCustomAgentId", () => {
  it.each([
    { name: "slugs free text", input: "My Agent 2!", expected: "my-agent-2" },
    { name: "collapses separators and trims dashes", input: "  --Agent__  ", expected: "agent" },
    { name: "caps at 32 chars", input: "a".repeat(40), expected: "a".repeat(32) },
    { name: "empty for non-strings", input: undefined, expected: "" },
  ])("$name", ({ input, expected }) => {
    expect(normalizeCustomAgentId(input)).toBe(expected);
  });
});

describe("normalizeCustomAgents", () => {
  it("keeps a well-formed agent and fills every optional with a default", () => {
    expect(normalizeCustomAgents([base])).toEqual([
      {
        id: "my-agent",
        label: "My Agent",
        command: "C:\\tools\\agent.exe",
        args: [],
        restoreMode: "resume",
        suppressReplayOnLoad: false,
        parameterizedModelPicker: true,
        subagentStreaming: false,
        cloudCatalog: false,
      },
    ]);
  });

  it("falls back to the id when the label is blank", () => {
    expect(normalizeCustomAgents([{ ...base, label: "   " }])[0]?.label).toBe("my-agent");
  });

  it.each([
    { name: "reserved id", entry: { ...base, id: "cursor" }, reserved: ["cursor"] },
    { name: "id with no legal chars", entry: { ...base, id: "!!!" } },
    { name: "missing command", entry: { ...base, command: "  " } },
    { name: "non-object entry", entry: "my-agent" },
  ])("drops $name", ({ entry, reserved }) => {
    expect(normalizeCustomAgents([entry], reserved ?? [])).toEqual([]);
  });

  it("keeps the first of two agents sharing an id", () => {
    const kept = normalizeCustomAgents([base, { ...base, label: "Second" }]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe("My Agent");
  });

  it("caps the list at CUSTOM_AGENT_MAX", () => {
    const many = Array.from({ length: CUSTOM_AGENT_MAX + 5 }, (_, i) => ({
      ...base,
      id: `agent-${i}`,
    }));
    expect(normalizeCustomAgents(many)).toHaveLength(CUSTOM_AGENT_MAX);
  });

  it("sanitizes args, env and binary dirs", () => {
    const [agent] = normalizeCustomAgents([
      {
        ...base,
        args: ["--install", "C:\\Program Files\\ZCode", 5, "  "],
        env: { ZCODE_LOG: "info", "not a key": "x", NUMERIC: 7 },
        binaryDirs: ["zcode-acp", "with/slashes", "", "x".repeat(80)],
      },
    ]);
    expect(agent?.args).toEqual(["--install", "C:\\Program Files\\ZCode"]);
    expect(agent?.env).toEqual({ ZCODE_LOG: "info" });
    expect(agent?.binaryDirs).toEqual(["zcode-acp", "withslashes", "x".repeat(64)]);
  });

  it("honours an explicit restore mode and replay flag", () => {
    const [agent] = normalizeCustomAgents([
      { ...base, restoreMode: "load", suppressReplayOnLoad: true, parameterizedModelPicker: false },
    ]);
    expect(agent?.restoreMode).toBe("load");
    expect(agent?.suppressReplayOnLoad).toBe(true);
    expect(agent?.parameterizedModelPicker).toBe(false);
  });
});

describe("customAgentAdapter", () => {
  const adapter = customAgentAdapter({
    id: "my-agent",
    label: "My Agent",
    command: "C:\\tools\\agent.exe",
    args: ["--stdio"],
    env: { AGENT_LOG: "info" },
  });

  it("maps the spec onto the harness contract with no settings fields", () => {
    expect(adapter).toMatchObject({
      id: "my-agent",
      label: "My Agent",
      custom: true,
      commandField: "",
      argsField: "",
      defaultCommand: "C:\\tools\\agent.exe",
      defaultArgs: ["--stdio"],
      restoreMode: "resume",
      parameterizedModelPicker: true,
      subagentStreaming: false,
      cloudCatalog: false,
      defaultModes: [],
      subagentToolKinds: [],
      env: { AGENT_LOG: "info" },
    });
    expect(adapter.extensionKinds).toEqual({});
  });

  it("asks the core for permission cards (generic ACP request names)", () => {
    expect(adapter.requestKinds["session/request_permission"]).toBe("permission");
  });
});
