import { describe, expect, it, vi } from "vitest";
import { NoOutputGeneratedError, streamText, type ModelMessage } from "ai";
import { compactMessages, pruneMessages, renderTranscript, runTurn, runTurnWithRetry } from "./loop.js";

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: vi.fn(),
}));

/** One user turn + its assistant reply, padded to `size` characters each. */
function turn(marker: string, size: number): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `${marker}-u${"x".repeat(size)}` }] },
    { role: "assistant", content: [{ type: "text", text: `${marker}-a${"x".repeat(size)}` }] },
  ];
}

function text(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const first = message.content[0];
  if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

describe("pruneMessages", () => {
  it("keeps everything while it fits", () => {
    const messages = [...turn("t0", 100), ...turn("t1", 100)];
    expect(pruneMessages(messages, 100_000)).toBe(messages);
  });

  it("keeps everything when no context window is known", () => {
    const messages = [...turn("t0", 10_000), ...turn("t1", 10_000)];
    expect(pruneMessages(messages, 0)).toBe(messages);
  });

  it("drops whole turns and keeps the largest window that fits", () => {
    // Budget = 1000 * 0.8 * 4 = 3200 chars: three turns overflow it, two fit.
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600)];
    const pruned = pruneMessages(messages, 1000);

    expect(pruned.length).toBeLessThan(messages.length);
    expect(pruned[0]!.role).toBe("user");
    // The cut must land on a turn boundary and keep the two newest turns —
    // pruning to the last turn alone would throw away history that fits.
    expect(text(pruned[0]!)).toMatch(/^t1-u/);
    expect(pruned).toHaveLength(4);
    expect(text(pruned[3]!)).toMatch(/^t2-a/);
  });

  it("falls back to the newest turn when even that overflows", () => {
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 5000)];
    const pruned = pruneMessages(messages, 1000);

    expect(pruned[0]!.role).toBe("user");
    expect(text(pruned[0]!)).toMatch(/^t2-u/);
    expect(pruned).toHaveLength(2);
  });

  it("never starts mid-turn when there is nothing to cut at", () => {
    // A single user message at index 0 is not a cut point — dropping the rest
    // would start the thread with an assistant message, which the SDK rejects.
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      ...Array.from(
        { length: 3 },
        (_, i): ModelMessage => ({
          role: "assistant",
          content: [{ type: "text", text: `a${i}${"x".repeat(5_000)}` }],
        }),
      ),
    ];
    expect(pruneMessages(messages, 1000)).toBe(messages);
  });
});

describe("compactMessages", () => {
  it("does not summarise while the history fits", async () => {
    const messages = [...turn("t0", 100), ...turn("t1", 100)];
    const summarize = vi.fn(async () => "unused");
    await expect(compactMessages({ messages, contextWindow: 100_000, summarize })).resolves.toBe(
      messages,
    );
    expect(summarize).not.toHaveBeenCalled();
  });

  it("replaces the oldest turns with a summary and keeps the recent ones verbatim", async () => {
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600)];
    const summarize = vi.fn(async () => "the task was X");
    const compacted = await compactMessages({ messages, contextWindow: 1000, summarize });

    expect(compacted[0]!.role).toBe("user");
    expect(text(compacted[0]!)).toContain("the task was X");
    expect(summarize).toHaveBeenCalledTimes(1);
    // The newest turns survive untouched — that is the whole point of this
    // over pruneMessages, which would have dropped them.
    expect(text(compacted[compacted.length - 1]!)).toMatch(/^t2-a/);
    expect(compacted.length).toBeGreaterThan(1);
  });

  it("falls back to pruning when the summariser fails", async () => {
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600)];
    const summarize = vi.fn(async () => {
      throw new Error("model exploded");
    });
    const compacted = await compactMessages({ messages, contextWindow: 1000, summarize });
    expect(compacted).toEqual(pruneMessages(messages, 1000));
  });

  it("falls back to pruning when the summary fails to shrink the view", async () => {
    // A summariser that retells instead of condensing leaves the view above
    // the trigger line: nearly everything is re-read anyway, and the cached
    // prefix is destroyed on top. Pruning is strictly better there.
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600)];
    const summarize = vi.fn(async () => "retold: " + "x".repeat(20_000));
    const compacted = await compactMessages({ messages, contextWindow: 1000, summarize });
    expect(compacted).toEqual(pruneMessages(messages, 1000));
  });

  it("falls back to pruning when the summary comes back empty", async () => {
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600)];
    const compacted = await compactMessages({
      messages,
      contextWindow: 1000,
      summarize: async () => "   ",
    });
    expect(compacted).toEqual(pruneMessages(messages, 1000));
  });

  it("summarises tool calls and their results, not just prose", () => {
    const transcript = renderTranscript([
      { role: "user", content: [{ type: "text", text: "fix the test" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "1", toolName: "bash", input: { command: "npm test" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "1 failed" },
          },
        ],
      },
    ]);
    expect(transcript).toContain("fix the test");
    expect(transcript).toContain("npm test");
    expect(transcript).toContain("1 failed");
  });
});

describe("runTurn failure handling", () => {
  /** APICallError shape: an Error plus the provider response fields. */
  function apiError(overrides: Record<string, unknown> = {}): Error {
    return Object.assign(new Error("Invalid API key"), {
      name: "AI_APICallError",
      statusCode: 401,
      url: "http://127.0.0.1:4096/api/chat",
      responseBody: '{"error":"Unauthorized"}',
      ...overrides,
    });
  }

  async function* streamOf(parts: unknown[]): AsyncGenerator<unknown> {
    for (const part of parts) yield part;
  }

  /** The SDK rejects every result promise with this when no step completed. */
  const noOutput = () => ({
    responseMessages: Promise.reject(new NoOutputGeneratedError()),
    finishReason: Promise.reject(new NoOutputGeneratedError()),
    usage: Promise.reject(new NoOutputGeneratedError()),
  });

  function turnOpts(opts: Partial<Parameters<typeof runTurn>[0]> = {}): Parameters<typeof runTurn>[0] {
    return {
      model: {} as Parameters<typeof runTurn>[0]["model"],
      system: "test",
      messages: [],
      tools: {},
      abortSignal: new AbortController().signal,
      contextWindow: 100_000,
      emit: () => {},
      ...opts,
    };
  }

  function mockStream(result: Record<string, unknown>): void {
    vi.mocked(streamText).mockReturnValue(result as never);
  }

  async function caughtRun(opts: Partial<Parameters<typeof runTurn>[0]>): Promise<Error> {
    try {
      await runTurn(turnOpts(opts));
      throw new Error("runTurn resolved, expected a rejection");
    } catch (err) {
      return err as Error;
    }
  }

  it("reports the provider error, not the SDK's generic no-output one", async () => {
    mockStream({
      fullStream: streamOf([{ type: "error", error: apiError() }]),
      ...noOutput(),
    });
    const err = await caughtRun({});
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("Invalid API key");
    expect(err.message).not.toContain("No output generated");
  });

  it("names the endpoint so the misconfigured provider is identifiable", async () => {
    mockStream({
      fullStream: streamOf([{ type: "error", error: apiError() }]),
      ...noOutput(),
    });
    const err = await caughtRun({});
    expect(err.message).toContain("http://127.0.0.1:4096/api/chat");
  });

  it("appends the response body when it says more than the provider text", async () => {
    mockStream({
      fullStream: streamOf([
        { type: "error", error: apiError({ message: "Unauthorized", responseBody: '{"error":"bad x-header"}' }) },
      ]),
      ...noOutput(),
    });
    const err = await caughtRun({});
    expect(err.message).toContain("bad x-header");
  });

  it("keeps the original error as the cause", async () => {
    const error = apiError();
    mockStream({ fullStream: streamOf([{ type: "error", error }]), ...noOutput() });
    const err = await caughtRun({});
    expect((err as { cause?: unknown }).cause).toBe(error);
  });

  it("takes status and body from the last retried provider error", async () => {
    mockStream({
      fullStream: streamOf([
        {
          type: "error",
          error: Object.assign(new Error("Failed after 3 attempts. Last error: rate limited"), {
            errors: [
              apiError({ statusCode: 429, message: "rate limited", responseBody: "too many requests" }),
            ],
          }),
        },
      ]),
      ...noOutput(),
    });
    const err = await caughtRun({});
    expect(err.message).toContain("HTTP 429");
    expect(err.message).toContain("rate limited");
    expect(err.message).toContain("too many requests");
  });

  it("reports the last call's tokens as the context, not the sum over steps", async () => {
    const updates: Array<Record<string, unknown>> = [];
    mockStream({
      fullStream: streamOf([]),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      // ai@7: `usage` is the sum over all steps — three tool steps that each
      // re-read the growing window add up to 3600, but the live window only
      // ever held the last call's 1500.
      usage: Promise.resolve({ totalTokens: 3600, inputTokens: 3300, outputTokens: 300 }),
      steps: Promise.resolve([
        { usage: { totalTokens: 900, inputTokens: 800, outputTokens: 100 } },
        { usage: { totalTokens: 1200, inputTokens: 1100, outputTokens: 100 } },
        { usage: { totalTokens: 1500, inputTokens: 1400, outputTokens: 100 } },
      ]),
    });

    await runTurn(turnOpts({ emit: (update) => updates.push(update) }));
    const usage = updates.find((u) => u.sessionUpdate === "usage_update");
    expect(usage).toMatchObject({ used: 1500, inputTokens: 3300, outputTokens: 300 });
  });

  it("returns a mid-turn failure in the outcome while keeping the streamed text", async () => {
    const updates: Array<Record<string, unknown>> = [];
    mockStream({
      fullStream: streamOf([
        { type: "text-delta", text: "partial answer" },
        { type: "error", error: apiError({ statusCode: 502, message: "bad gateway", responseBody: "" }) },
      ]),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      totalUsage: Promise.resolve({ totalTokens: 0 }),
      usage: Promise.resolve({ totalTokens: 0 }),
    });

    const outcome = await runTurn(turnOpts({ emit: (update) => updates.push(update) }));
    expect(outcome.failure?.message).toContain("HTTP 502");
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
  });

  it("stays quiet when the turn was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    mockStream({
      fullStream: streamOf([{ type: "error", error: apiError() }]),
      ...noOutput(),
    });

    const outcome = await runTurn(turnOpts({ abortSignal: controller.signal }));
    expect(outcome.failure).toBeUndefined();
    expect(outcome.stopReason).toBe("end_turn");
  });

  it("flags a turn that ended on the step ceiling", async () => {
    mockStream({
      fullStream: streamOf([{ type: "text-delta", text: "kept going" }]),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("tool-calls"),
      totalUsage: Promise.resolve({ totalTokens: 0 }),
      usage: Promise.resolve({ totalTokens: 0 }),
      steps: Promise.resolve(Array.from({ length: 120 }, () => ({}))),
    });

    const outcome = await runTurn(turnOpts({ maxSteps: 120 }));
    expect(outcome.stepBudgetHit).toBe(true);
  });

  it("does not flag a turn that stopped on its own", async () => {
    mockStream({
      fullStream: streamOf([]),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      totalUsage: Promise.resolve({ totalTokens: 0 }),
      usage: Promise.resolve({ totalTokens: 0 }),
      steps: Promise.resolve(Array.from({ length: 5 }, () => ({}))),
    });

    const outcome = await runTurn(turnOpts({ maxSteps: 120 }));
    expect(outcome.stepBudgetHit).toBeUndefined();
  });
});

describe("runTurnWithRetry", () => {
  const outcome = { response: [], stopReason: "end_turn" as const };
  const opts = (overrides: Partial<Parameters<typeof runTurnWithRetry>[1]> = {}) => ({
    signal: new AbortController().signal,
    attempts: 3,
    note: () => {},
    ...overrides,
  });

  it("returns the first success untouched", async () => {
    const run = vi.fn().mockResolvedValue(outcome);
    const res = await runTurnWithRetry(run, opts());
    expect(res.stopReason).toBe("end_turn");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reruns the turn after a dead stream and succeeds", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue(outcome);
    const notes: string[] = [];
    const res = await runTurnWithRetry(run, opts({ note: (m) => notes.push(m) }));
    expect(res.stopReason).toBe("end_turn");
    expect(run).toHaveBeenCalledTimes(2);
    expect(notes).toEqual([expect.stringContaining("повторяю ход (2 из 3)")]);
  });

  it("gives up after the last attempt with the original error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("endpoint down"));
    await expect(runTurnWithRetry(run, opts())).rejects.toThrow("endpoint down");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not retry a turn the user cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockRejectedValue(new Error("endpoint down"));
    await expect(runTurnWithRetry(run, opts({ signal: controller.signal }))).rejects.toThrow(
      "endpoint down",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

