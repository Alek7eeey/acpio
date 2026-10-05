import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamText } from "ai";
import type { AskPermission } from "./tools.js";
import {
  createSubagentsBridge,
  EXPLORE_SUBAGENT,
  makeTaskTool,
  resolveSubagent,
  runSubagent,
  SUBAGENT_RESULT_MAX_CHARS,
  type SubagentsBridge,
} from "./subagents.js";

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: vi.fn(),
}));

beforeEach(() => {
  // Clear call counts (not implementations) so per-test expectations on
  // streamText/ask see only their own calls.
  vi.clearAllMocks();
});

async function* streamOf(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

/** A resolved child turn: one final assistant message, usage for one call. */
function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fullStream: streamOf([]),
    responseMessages: Promise.resolve([
      { role: "assistant", content: [{ type: "text", text: "final report" }] },
    ]),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      inputTokenDetails: { cacheReadTokens: 10 },
    }),
    steps: Promise.resolve([{ usage: { totalTokens: 150 } }]),
    ...overrides,
  };
}

function testBridge(overrides: Partial<Parameters<typeof createSubagentsBridge>[0]> = {}): {
  bridge: SubagentsBridge;
  childAsks: AskPermission[];
} {
  const childAsks: AskPermission[] = [];
  const bridge = createSubagentsBridge({
    mode: "agent",
    ask: vi.fn(async () => {}),
    model: {} as Parameters<typeof runSubagent> extends never ? never : never,
    contextWindow: 100_000,
    cwd: "C:/work",
    signal: new AbortController().signal,
    settings: { enabled: true, allowAdhoc: true, agents: [] },
    emit: vi.fn(),
    buildChildTools: vi.fn((ask: AskPermission) => {
      childAsks.push(ask);
      return {
        read: { description: "read" },
        glob: { description: "glob" },
        grep: { description: "grep" },
        write: { description: "write" },
        bash: { description: "bash" },
      };
    }),
    ...overrides,
  });
  return { bridge, childAsks };
}

function lastCall(): Record<string, unknown> {
  const calls = vi.mocked(streamText).mock.calls;
  return calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
}

describe("resolveSubagent", () => {
  it("finds the built-in explore agent case-insensitively", () => {
    const { bridge } = testBridge();
    expect(resolveSubagent(bridge, { agent: "Explore", prompt: "x" }).id).toBe(
      EXPLORE_SUBAGENT.id,
    );
  });

  it("rejects an unknown name with the roster", () => {
    const { bridge } = testBridge();
    expect(() => resolveSubagent(bridge, { agent: "nope", prompt: "x" })).toThrow(
      /Available: explore/,
    );
  });

  it("rejects an ad-hoc spawn when the feature disallows it", () => {
    const { bridge } = testBridge({
      settings: { enabled: true, allowAdhoc: false, agents: [] },
    });
    expect(() =>
      resolveSubagent(bridge, { system_prompt: "Do things.", prompt: "x" }),
    ).toThrow(/ad-hoc subagents are disabled/i);
  });

  it("rejects both or neither of agent/system_prompt", () => {
    const { bridge } = testBridge();
    expect(() =>
      resolveSubagent(bridge, { agent: "explore", system_prompt: "Both.", prompt: "x" }),
    ).toThrow(/not both/i);
    expect(() => resolveSubagent(bridge, { prompt: "x" })).toThrow(/Pass `agent`/);
  });
});

describe("runSubagent", () => {
  it("runs the child with the report contract, the task prompt and no task tool", async () => {
    vi.mocked(streamText).mockReturnValue(outcome() as never);
    const { bridge } = testBridge();
    const report = await runSubagent(bridge, "p1", {
      agent: "explore",
      prompt: "Where is auth implemented?",
    });

    expect(report).toBe("final report");
    const opts = lastCall();
    const system = String(opts.system);
    expect(system).toContain("Working rules:");
    expect(system).toContain("Working directory: C:/work");
    expect(system).toContain("codebase explorer");
    expect(JSON.stringify(opts.messages)).toContain("Where is auth implemented?");
    // The child's toolset is the definition's tools ∩ the mode — never `task`.
    expect(Object.keys(opts.tools as Record<string, unknown>)).toEqual([
      "read",
      "glob",
      "grep",
    ]);
    // The child's spend is accumulated for the parent's usage update.
    expect(bridge.usage).toEqual({
      inputTokens: 60,
      outputTokens: 40,
      cachedInputTokens: 10,
      totalTokens: 150,
    });
  });

  it("intersects requested ad-hoc tools with the parent mode", async () => {
    vi.mocked(streamText).mockReturnValue(outcome() as never);
    const { bridge: agentBridge } = testBridge();
    await runSubagent(agentBridge, "p1", {
      system_prompt: "Runner.",
      tools: ["bash", "write", "mcp__nope"],
      prompt: "x",
    });
    expect(Object.keys(lastCall().tools as Record<string, unknown>)).toEqual([
      "bash",
      "write",
    ]);

    // Plan mode has no mutating tools to give, so the request falls back to
    // the read-only default.
    const { bridge: planBridge } = testBridge({ mode: "plan" });
    await runSubagent(planBridge, "p2", {
      system_prompt: "Runner.",
      tools: ["bash"],
      prompt: "x",
    });
    expect(Object.keys(lastCall().tools as Record<string, unknown>)).toEqual([
      "read",
      "glob",
      "grep",
    ]);
  });

  it("labels the child's permission asks with the agent name", async () => {
    vi.mocked(streamText).mockReturnValue(outcome() as never);
    const { bridge, childAsks } = testBridge();
    await runSubagent(bridge, "p1", { agent: "explore", prompt: "x" });
    await childAsks[0]!({ title: "bash ls", kind: "execute", input: { command: "ls" } });
    expect(bridge.ask).toHaveBeenCalledWith({
      title: "[explore] bash ls",
      kind: "execute",
      input: { command: "ls" },
    });
  });

  it("streams child tool calls into the parent's card as thinking lines", async () => {
    vi.mocked(streamText).mockReturnValue(
      outcome({
        fullStream: streamOf([
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.ts" } },
          { type: "tool-result", toolCallId: "c1" },
        ]),
      }) as never,
    );
    const { bridge } = testBridge();
    await runSubagent(bridge, "p1", { agent: "explore", prompt: "x" });

    const chunks = vi.mocked(bridge.emit).mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((update) => update.sessionUpdate === "tool_call_content_chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ toolCallId: "p1" });
    const block = (chunks[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(block.type).toBe("thinking");
    expect(String(block.text)).toMatch(/^1 · read /);
  });

  it("does not forward the child's message or usage updates to the parent", async () => {
    vi.mocked(streamText).mockReturnValue(
      outcome({
        fullStream: streamOf([
          { type: "text-delta", id: "t1", text: "thinking out loud" },
        ]),
      }) as never,
    );
    const { bridge } = testBridge();
    await runSubagent(bridge, "p1", { agent: "explore", prompt: "x" });
    const forwarded = vi.mocked(bridge.emit).mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .map((update) => update.sessionUpdate);
    expect(forwarded).not.toContain("agent_message_chunk");
    expect(forwarded).not.toContain("usage_update");
  });

  it("clips an overlong report and notes an exhausted step budget", async () => {
    const long = "x".repeat(SUBAGENT_RESULT_MAX_CHARS + 5_000);
    vi.mocked(streamText).mockReturnValue(
      outcome({
        responseMessages: Promise.resolve([
          { role: "assistant", content: [{ type: "text", text: long }] },
        ]),
        steps: Promise.resolve(Array.from({ length: 30 }, () => ({ usage: { totalTokens: 0 } }))),
      }) as never,
    );
    const { bridge } = testBridge();
    const report = await runSubagent(bridge, "p1", { agent: "explore", prompt: "x" });
    expect(report).toContain(`[report truncated at ${SUBAGENT_RESULT_MAX_CHARS} chars]`);
    expect(report).toContain("Step budget exhausted");
  });

  it("caps concurrent children at three", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(streamText).mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const result = outcome();
      void (result.responseMessages as Promise<unknown>).then(() => {
        inFlight -= 1;
      });
      return result as never;
    });
    const { bridge } = testBridge();
    const runs = Array.from({ length: 5 }, (_, i) =>
      runSubagent(bridge, `p${i}`, { agent: "explore", prompt: `t${i}` }),
    );
    const reports = await Promise.all(runs);
    expect(streamText).toHaveBeenCalledTimes(5);
    // Five children, three slots: the semaphore serializes the overflow.
    expect(peak).toBe(3);
    expect(reports.every((report) => report === "final report")).toBe(true);
  });
});

describe("makeTaskTool", () => {
  it("describes the roster and stores the report for the card", async () => {
    vi.mocked(streamText).mockReturnValue(outcome() as never);
    const { bridge } = testBridge({
      settings: {
        enabled: true,
        allowAdhoc: true,
        agents: [
          {
            id: "s1",
            name: "tester",
            description: "Runs the tests.",
            systemPrompt: "You run tests.",
            tools: ["read", "bash"],
            maxTurns: 20,
          },
        ],
      },
    });
    const task = makeTaskTool(bridge);
    expect(task.description).toContain("explore —");
    expect(task.description).toContain("tester — Runs the tests.");
    expect(task.description).toContain("ad-hoc");

    const execute = (task as { execute: (input: unknown, ctx: unknown) => Promise<string> })
      .execute;
    const report = await execute({ agent: "tester", prompt: "run tests" }, { toolCallId: "p9" });
    expect(report).toBe("final report");
    expect(bridge.results.get("p9")).toBe("final report");
  });
});
