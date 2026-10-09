import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { compactMessages, pruneMessages, renderTranscript } from "./loop.js";

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
