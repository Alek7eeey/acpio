import { describe, expect, it, vi } from "vitest";
import { NoOutputGeneratedError, streamText, type ModelMessage } from "ai";
import {
  compactHistory,
  compactMessages,
  estimateTokens,
  pruneMessages,
  renderTranscript,
  runTurn,
  runTurnWithRetry,
} from "./loop.js";

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

  it("fires at a lowered line but still has to land under the configured one", async () => {
    // `/compact`: the reader asked for a pass now, so the trigger drops to 1%.
    // What the pass produces still has to sit under the line the setting names
    // (80%) — a digest above it re-reads everything and only kills the cache.
    const messages = [...turn("t0", 600), ...turn("t1", 600), ...turn("t2", 600), ...turn("t3", 600)];
    const summarize = vi.fn(async () => "the task was X");
    const forced = await compactHistory({
      messages,
      contextWindow: 1000,
      thresholdPercent: 1,
      fitPercent: 80,
      summarize,
    });
    expect(forced.state?.covered).toBeGreaterThan(0);
    expect(text(forced.messages[0]!)).toContain("the task was X");
    expect(estimateTokens(forced.messages)).toBeLessThanOrEqual(1000 * 0.8);

    // The tail budget is measured against the *fit* line: with the trigger line
    // alone it collapses to a negative slice and the pass has nowhere to cut.
    const collapsed = await compactHistory({
      messages,
      contextWindow: 1000,
      thresholdPercent: 1,
      summarize,
    });
    expect(collapsed.state).toBeUndefined();
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

  it("counts an attachment by its pixels, not by the length of its base64", () => {
    const shot: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "посмотри на скриншот" },
          { type: "file", mediaType: "image/png", data: "A".repeat(400_000) },
        ],
      },
    ];
    // A megabyte of base64 is one image on the wire (~1.5k tokens), not 250k:
    // counting it by length fires the pass on a history that fits, and the row
    // then reports a window the model never had.
    expect(estimateTokens(shot)).toBeLessThan(3_000);
    // Text is still measured as before — no threshold shifts for text-only chats.
    const prose: ModelMessage[] = [
      { role: "user", content: "просто текст" },
      { role: "assistant", content: "ок" },
    ];
    const chars = prose.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
    expect(estimateTokens(prose)).toBe(Math.ceil(chars / 4));
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

describe("compactHistory with a carried digest", () => {
  /**
   * A session after its first pass: the bulky prefix is already spoken for by
   * a digest, the verbatim tail is the recent turns. The raw transcript sits
   * far over the line — the digest + tail view the model really gets does not.
   */
  const digested = () => {
    const prefix = [...turn("old0", 6_000), ...turn("old1", 6_000), ...turn("old2", 6_000)];
    // Big enough that the old cut search walks past it, small enough that
    // digest + tail still sits under the line on its own.
    const tail = [...turn("new0", 1_200), ...turn("new1", 50)];
    return {
      messages: [...prefix, ...tail],
      state: { summary: "старый конспект", covered: prefix.length },
    };
  };

  it("reads the line on the digested view: no pass while it fits, however big the stored history", async () => {
    const { messages, state } = digested();
    // The raw side of the fixture is over the line; the digested view is not.
    expect(estimateTokens(messages)).toBeGreaterThan(1_000 * 0.8);
    const summarize = vi.fn(async () => "unused");
    const update = vi.fn(async () => "unused");

    const result = await compactHistory({
      messages,
      contextWindow: 1_000,
      thresholdPercent: 80,
      keepRecentPercent: 20,
      state,
      summarize,
      update,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.state).toBe(state);
    // The prompt keeps the digest and the verbatim tail — the covered prefix
    // never comes back into the window.
    expect(result.messages).toHaveLength(messages.length - state.covered + 1);
    expect(text(result.messages[0]!)).toContain("старый конспект");
    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(1_000 * 0.8);
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

  it("reports the live window while the turn is still running", async () => {
    const updates: Array<Record<string, unknown>> = [];
    // The turn parks between its two calls, so the assertions below run with the
    // stream open: whatever a running chat can show, it must have shown already.
    let releaseSecondCall: () => void = () => {};
    const secondCall = new Promise<void>((resolve) => {
      releaseSecondCall = resolve;
    });
    let reachedGate: () => void = () => {};
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    async function* stream(): AsyncGenerator<unknown> {
      yield {
        type: "finish-step",
        usage: {
          totalTokens: 900,
          inputTokens: 800,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 700 },
        },
      };
      // The consumer resumes this body only after it handled the part above.
      reachedGate();
      await secondCall;
      yield { type: "text-delta", text: "answer" };
      yield {
        type: "finish-step",
        usage: {
          totalTokens: 1500,
          inputTokens: 1400,
          outputTokens: 100,
          inputTokenDetails: { cacheReadTokens: 0 },
        },
      };
    }
    mockStream({
      fullStream: stream(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 3600, inputTokens: 3300, outputTokens: 300 }),
      steps: Promise.resolve([
        { usage: { totalTokens: 900, inputTokens: 800, outputTokens: 100 } },
        { usage: { totalTokens: 1500, inputTokens: 1400, outputTokens: 100 } },
      ]),
    });

    const running = runTurn(turnOpts({ emit: (update) => updates.push(update) }));
    await atGate;
    const midTurn = updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(midTurn).toHaveLength(1);
    expect(midTurn[0]).toMatchObject({
      used: 900,
      size: 100_000,
      inputTokens: 800,
      outputTokens: 100,
      cachedInputTokens: 700,
    });

    releaseSecondCall();
    await running;
    // The turn's own report closes it: the last call's window, and only the
    // part of the bill its step reports did not already put on the wire — the
    // harness stores the latest update, so re-stating the steps' own calls
    // would leave the session's totals the victim of whatever report came last.
    const reports = updates.filter((u) => u.sessionUpdate === "usage_update");
    expect(reports).toHaveLength(3);
    expect(reports.at(-1)).toMatchObject({ used: 1500, inputTokens: 1100, outputTokens: 100 });
    // The three reports together are the turn's bill to the token: 800 + 1400 +
    // 1100 in, 100 + 100 + 100 out — nothing double-charged, nothing dropped.
    const sum = (key: "inputTokens" | "outputTokens") =>
      reports.reduce((total, report) => total + (Number(report[key]) || 0), 0);
    expect(sum("inputTokens")).toBe(3300);
    expect(sum("outputTokens")).toBe(300);
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

  it("folds a mid-turn message into the next model call, then records where it belongs", async () => {
    const hi: ModelMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    const step0: ModelMessage = { role: "assistant", content: [{ type: "text", text: "step 0" }] };
    const step1: ModelMessage = { role: "assistant", content: [{ type: "text", text: "step 1" }] };
    const steer: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "вклинилось между вызовами" }],
    };
    const acked = vi.fn();
    // Nothing pending before step 0, the host's message before step 1.
    const takeSteer = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ message: steer, ack: acked }]);
    /** The prompts the SDK would actually send, one per model call. */
    const prompts: ModelMessage[][] = [];
    vi.mocked(streamText).mockImplementation(((
      opts: Parameters<typeof runTurn>[0] & { prepareStep?: (args: unknown) => { messages?: ModelMessage[] } },
    ) => {
      for (const [step, args] of [
        { messages: [hi], responseMessages: [] },
        { messages: [hi, step0], responseMessages: [step0] },
      ].entries()) {
        const override = opts.prepareStep?.(args);
        prompts.push(override?.messages ?? args.messages);
        // The default path must stay untouched: no pending message, no override.
        if (step === 0) expect(override).toEqual({});
      }
      return {
        fullStream: streamOf([]),
        responseMessages: Promise.resolve([step0, step1]),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 0 }),
        steps: Promise.resolve([]),
      } as never;
    }) as never);

    const outcome = await runTurn(turnOpts({ takeSteer }));

    // The text rides with the call after the step the host aimed it at — and
    // only with that one, not with every later step twice.
    expect(prompts[0]).toEqual([hi]);
    expect(prompts[1]).toEqual([hi, step0, steer]);
    // Acknowledged exactly when it really joined a prompt.
    expect(acked).toHaveBeenCalledTimes(1);
    expect(takeSteer).toHaveBeenCalledTimes(2);
    // In the history it sits where the model read it: between step 0 and step 1.
    expect(outcome.injected).toEqual([{ at: 1, message: steer }]);
    const history = [...outcome.response];
    for (const { at, message } of outcome.injected ?? []) history.splice(at, 0, message);
    expect(history).toEqual([step0, steer, step1]);
  });

  it("reports a step that stopped on reasoning alone as a broken chain", async () => {
    // The shape the report showed: the last step wrote thinking and nothing
    // else, so the turn ended with no answer at all.
    mockStream({
      fullStream: streamOf([{ type: "reasoning-delta", text: "надо подумать" }]),
      responseMessages: Promise.resolve([
        { role: "assistant", content: [{ type: "reasoning", text: "надо подумать" }] },
      ]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 0 }),
    });

    const outcome = await runTurn(turnOpts({}));
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.truncated).toBe(true);
  });

  it("reports an answer the output cap cut short as a broken chain", async () => {
    mockStream({
      fullStream: streamOf([{ type: "text-delta", text: "начал писать" }]),
      responseMessages: Promise.resolve([
        { role: "assistant", content: [{ type: "text", text: "начал писать" }] },
      ]),
      finishReason: Promise.resolve("length"),
      usage: Promise.resolve({ totalTokens: 0 }),
    });

    const outcome = await runTurn(turnOpts({}));
    expect(outcome.stopReason).toBe("max_tokens");
    expect(outcome.truncated).toBe(true);
  });

  it("leaves a turn that answered alone", async () => {
    const answered = (messages: ModelMessage[]) => {
      mockStream({
        fullStream: streamOf([]),
        responseMessages: Promise.resolve(messages),
        finishReason: Promise.resolve("stop"),
        usage: Promise.resolve({ totalTokens: 0 }),
        steps: Promise.resolve([]),
      });
      return runTurn(turnOpts({}));
    };

    // Written answer.
    expect((await answered([{ role: "assistant", content: [{ type: "text", text: "вот ответ" }] }])).truncated)
      .toBeUndefined();
    // A step that called a tool: the turn goes on, it is not a lost answer.
    const tooled = await answered([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "read", output: {} }] },
    ]);
    expect(tooled.truncated).toBeUndefined();
  });

  // The `/thinking-limit` fuse: a step that only thinks past the cap is cut,
  // and its reasoning is kept as the step's own message instead of vanishing.
  it("cuts a step whose reasoning crosses the limit and keeps the thinking", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const long = (n: number) => "мысл".repeat(n);
    async function* runaway(): AsyncGenerator<unknown> {
      yield { type: "start-step" };
      yield { type: "reasoning-delta", text: long(100) }; // 400 chars
      yield { type: "reasoning-delta", text: long(100) }; // 800 > 500 — cut
      // The real SDK ends the stream on abort; a mock keeps going, which only
      // proves the flag latches — no second cut, no growth.
      yield { type: "reasoning-delta", text: long(100) };
    }
    mockStream({
      fullStream: runaway(),
      ...noOutput(),
    });

    const outcome = await runTurn(
      turnOpts({ emit: (u) => updates.push(u), reasoningLimitChars: 500 }),
    );

    expect(outcome.reasoningLimitHit).toBe(true);
    // A cut step is not "truncated": its remedy is the reminder-continuation.
    expect(outcome.truncated).toBeUndefined();
    // The thinking survived as the step's own assistant message...
    expect(outcome.response).toHaveLength(1);
    const kept = outcome.response[0] as { role: string; content: Array<{ type: string; text: string }> };
    expect(kept.role).toBe("assistant");
    expect(kept.content[0]?.type).toBe("reasoning");
    // ...as much as streamed before the cut, not more (the latch stopped it).
    expect(kept.content[0]?.text.length).toBe(800);
    // The user sees why the stream stopped.
    const note = updates
      .filter((u) => u.sessionUpdate === "agent_thought_chunk")
      .map((u) => String((u.content as { text?: unknown }).text ?? ""))
      .join("");
    expect(note).toContain("обрезаны по лимиту 500");
  });

  it("stands the fuse down once the step starts acting", async () => {
    async function* acts(): AsyncGenerator<unknown> {
      yield { type: "start-step" };
      yield { type: "reasoning-delta", text: "x".repeat(400) };
      yield { type: "text-delta", text: "ответ" };
      // Late reasoning after the action is not cut — the answer is in flight.
      yield { type: "reasoning-delta", text: "y".repeat(400) };
    }
    mockStream({
      fullStream: acts(),
      responseMessages: Promise.resolve([
        { role: "assistant", content: [{ type: "text", text: "ответ" }] },
      ]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 0 }),
      steps: Promise.resolve([]),
    });

    const outcome = await runTurn(turnOpts({ reasoningLimitChars: 500 }));
    expect(outcome.reasoningLimitHit).toBeUndefined();
    expect(outcome.response).toHaveLength(1);
  });

  it("never cuts with the fuse off", async () => {
    async function* free(): AsyncGenerator<unknown> {
      yield { type: "start-step" };
      yield { type: "reasoning-delta", text: "z".repeat(5_000) };
    }
    mockStream({
      fullStream: free(),
      responseMessages: Promise.resolve([
        { role: "assistant", content: [{ type: "reasoning", text: "z".repeat(5_000) }] },
      ]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 0 }),
      steps: Promise.resolve([]),
    });

    const outcome = await runTurn(turnOpts({}));
    expect(outcome.reasoningLimitHit).toBeUndefined();
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

  // A tool can hold the wire quiet for minutes; the host's idle ceiling reads
  // silence as a hang (the 2026-10-08 "агент останавливается" incident).
  it("heartbeats while a tool runs, and only while a tool runs", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function* stream(): AsyncGenerator<unknown> {
      yield { type: "tool-call", toolCallId: "t1", toolName: "js", input: {} };
      await sleep(70); // silent span: only the heartbeat may speak
      yield { type: "tool-result", toolCallId: "t1", output: "ok" };
      await sleep(60); // tool closed — the heartbeat must be gone by now
    }
    mockStream({
      fullStream: stream(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 0, inputTokens: 0, outputTokens: 0 }),
      steps: Promise.resolve([]),
    });

    await runTurn(turnOpts({ emit: (u) => updates.push(u), heartbeatMs: 20 }));
    const kinds = updates.map((u) => u.sessionUpdate);
    const toolDone = kinds.indexOf("tool_call_update");
    expect(kinds.indexOf("tool_call")).toBeGreaterThanOrEqual(0);
    expect(toolDone).toBeGreaterThan(kinds.indexOf("tool_call"));
    // Alive during the silent run…
    expect(kinds.slice(0, toolDone).filter((k) => k === "heartbeat").length).toBeGreaterThanOrEqual(2);
    // …and silent the moment it finishes: a latched heartbeat would mask a
    // real hang after the tool.
    expect(kinds.slice(toolDone).filter((k) => k === "heartbeat")).toEqual([]);
  });

  it("does not heartbeat a turn with no tool in flight", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function* stream(): AsyncGenerator<unknown> {
      yield { type: "text-delta", text: "thinking…" };
      await sleep(60); // long quiet model call — no tool, no heartbeat
    }
    mockStream({
      fullStream: stream(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ totalTokens: 0, inputTokens: 0, outputTokens: 0 }),
      steps: Promise.resolve([]),
    });

    await runTurn(turnOpts({ emit: (u) => updates.push(u), heartbeatMs: 20 }));
    expect(updates.filter((u) => u.sessionUpdate === "heartbeat")).toEqual([]);
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

  // A mid-turn gateway failure does not throw: the stream already produced
  // messages, so the outcome resolves carrying `failure` and the messages the
  // dead step never answered. That shape used to end the session on the spot.
  const midTurnFailure = (message: string) => ({
    response: [{ role: "assistant" as const, content: "partial" }],
    stopReason: "end_turn" as const,
    failure: new Error(message),
  });

  it("reruns the model call when the failure came back with a resolved response", async () => {
    const failed = midTurnFailure("Модель ответила ошибкой (HTTP 400, https://gw/v1)");
    const kept: unknown[] = [];
    const notes: string[] = [];
    const run = vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(outcome);
    const res = await runTurnWithRetry(
      run,
      opts({ note: (m) => notes.push(m), keepPartial: (o) => kept.push(o) }),
    );
    expect(res.stopReason).toBe("end_turn");
    expect(run).toHaveBeenCalledTimes(2);
    // What the dead attempt produced is handed to the caller before the retry.
    expect(kept).toEqual([failed]);
    expect(notes).toEqual([expect.stringContaining("повторяю ход (2 из 3)")]);
    expect(notes[0]).toContain("HTTP 400");
  });

  it("keeps every failed attempt and gives the last one back", async () => {
    const run = vi.fn().mockImplementation(() => Promise.resolve(midTurnFailure("HTTP 400")));
    const kept: unknown[] = [];
    const res = await runTurnWithRetry(run, opts({ keepPartial: (o) => kept.push(o) }));
    expect(res.failure).toBeInstanceOf(Error);
    expect(run).toHaveBeenCalledTimes(3);
    expect(kept).toHaveLength(3);
  });

  it("does not rerun a failed turn the user cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockImplementation(() => Promise.resolve(midTurnFailure("HTTP 400")));
    const res = await runTurnWithRetry(run, opts({ signal: controller.signal }));
    expect(res.failure).toBeInstanceOf(Error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // A step the model never finished does not throw either: the outcome carries
  // `truncated` and the messages of the cut step. That shape used to end the
  // turn with the chat silent and the user typing "продолжай".
  // The reported transcript's shape: tool steps went through, and the last step
  // of the turn wrote nothing but thinking.
  const cutStep = () => ({
    response: [
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, toolCallId: "t", toolName: "read", input: {} }],
      },
      {
        role: "tool" as const,
        content: [{ type: "tool-result" as const, toolCallId: "t", toolName: "read", output: {} }],
      },
      { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "..." }] },
    ],
    stopReason: "end_turn" as const,
    truncated: true,
  });

  it("runs the turn on when its step ended without an answer", async () => {
    const cut = cutStep();
    const kept: unknown[] = [];
    const continued: unknown[] = [];
    const notes: string[] = [];
    const run = vi.fn().mockResolvedValueOnce(cut).mockResolvedValue(outcome);
    const res = await runTurnWithRetry(
      run,
      opts({
        note: (m) => notes.push(m),
        keepPartial: (o) => kept.push(o),
        continueAfter: (o) => continued.push(o),
      }),
    );
    expect(res.stopReason).toBe("end_turn");
    expect(run).toHaveBeenCalledTimes(2);
    // The cut step was folded, and the nudge follows it — in that order.
    expect(kept).toEqual([cut]);
    expect(continued).toEqual([cut]);
    expect(notes).toEqual([expect.stringContaining("оборвался")]);
    expect(notes[0]).toContain("1 из 2");
  });

  it("gives a cut turn a bounded number of continuations", async () => {
    const run = vi.fn().mockImplementation(() => Promise.resolve(cutStep()));
    const continued: unknown[] = [];
    const res = await runTurnWithRetry(run, opts({ continueAfter: (o) => continued.push(o) }));
    expect(res.truncated).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(continued).toHaveLength(2);
  });

  it("does not carry a cut turn on after the user cancelled it", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockImplementation(() => Promise.resolve(cutStep()));
    const res = await runTurnWithRetry(run, opts({ signal: controller.signal }));
    expect(res.truncated).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

