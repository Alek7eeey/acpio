import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { pruneMessages } from "./loop.js";

/** One user turn + its assistant reply, padded to `size` characters each. */
function turn(marker: string, size: number): ModelMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: `${marker}-u${"x".repeat(size)}` }] },
    { role: "assistant", content: [{ type: "text", text: `${marker}-a${"x".repeat(size)}` }] },
  ];
}

function text(message: ModelMessage): string {
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
