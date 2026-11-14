import { describe, expect, it, vi } from "vitest";
import { streamText, type ModelMessage } from "ai";
import { estimateTokens, runTurn } from "./loop.js";

/**
 * The prefix cache, and why this file exists.
 *
 * Chat c24d5224 ("Как получить эпики по выборке") started at 99% cached, took
 * one expected full-price call after a 72-minute pause — and then, as its view
 * came up to the compaction line, paid full price on nine separate steps for
 * cuts that freed a few hundred tokens each. The provider was never the problem:
 * a prefix cache matches from the first message, so a view whose head moved
 * between two steps is a view it has never seen.
 *
 * The fake provider below bills exactly that way: `cached` is the head of the
 * call it has already seen, `input` is the whole view, and a pause longer than
 * its TTL empties the cache — no vendor, no network, no tokens spent.
 */

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  streamText: vi.fn(),
}));

const WINDOW = 500_000;
/** `builtinCompactionThresholdPercent: 20` — the line that chat rode. */
const LINE = WINDOW * 0.2;
const TTL_MS = 60 * 60 * 1000;
const STEP_MS = 5_000;
const T0 = Date.parse("2026-11-13T12:00:00Z");

interface Bill {
  phase: string;
  input: number;
  cached: number;
  pct: number;
  msgs: number;
  /** Messages this call shares with the previous one, from the first index. */
  shared: number;
  cold: boolean;
}

/** A provider that bills a prefix, the way every cached-input API does. */
function prefixProvider() {
  let seen: ModelMessage[] = [];
  let seenAt = -Infinity;
  const bills: Bill[] = [];
  return {
    bills,
    bill(messages: ModelMessage[], at: number, phase: string): Bill {
      const cold = at - seenAt > TTL_MS;
      let shared = 0;
      if (!cold) {
        while (
          shared < Math.min(seen.length, messages.length) &&
          JSON.stringify(seen[shared]) === JSON.stringify(messages[shared])
        ) {
          shared++;
        }
      }
      const input = estimateTokens(messages);
      const cached = shared > 0 ? estimateTokens(seen.slice(0, shared)) : 0;
      const bill: Bill = {
        phase,
        input,
        cached,
        pct: input ? Math.round((cached / input) * 100) : 0,
        msgs: messages.length,
        shared,
        cold,
      };
      bills.push(bill);
      seen = messages;
      seenAt = at;
      return bill;
    },
  };
}

/** The turn's own `prepareStep`, as the SDK would have called it. */
async function stepOf(): Promise<(step: unknown) => Promise<{ messages?: ModelMessage[] }>> {
  let prepare: ((step: unknown) => Promise<{ messages?: ModelMessage[] }>) | undefined;
  vi.mocked(streamText).mockImplementation(((args: { prepareStep?: typeof prepare }) => {
    prepare = args.prepareStep;
    return {
      fullStream: (async function* () {})(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      steps: Promise.resolve([]),
    };
  }) as never);
  await runTurn({
    model: {} as Parameters<typeof runTurn>[0]["model"],
    system: "test",
    messages: [],
    tools: {},
    abortSignal: new AbortController().signal,
    contextWindow: WINDOW,
    emit: () => {},
  });
  if (!prepare) throw new Error("the turn handed the SDK no prepareStep");
  return prepare;
}

const pad = (size: number) => "x".repeat(Math.max(1, size));
const call = (i: number): ModelMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read", input: { path: `f${i}` } }],
});
const result = (i: number, chars: number): ModelMessage => ({
  role: "tool",
  content: [
    { type: "tool-result", toolCallId: `c${i}`, toolName: "read", output: { type: "text", value: pad(chars) } },
  ],
});

/** A history already this many tokens deep — the chat before the turn began. */
function preamble(tokens: number): ModelMessage[] {
  const out: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: `go ${pad(400)}` }] }];
  let left = tokens;
  for (let i = 0; left > 0; i++) {
    const size = Math.min(3_000, left);
    out.push({ role: "user", content: [{ type: "text", text: `#${i} ${pad(size * 4)}` }] });
    out.push({ role: "assistant", content: [{ type: "text", text: `ok ${pad(200)}` }] });
    left -= size;
  }
  return out;
}

/**
 * One turn of a chat, step by step: the view grows, the loop hands each step its
 * view, and the provider bills what it does not already hold as a prefix.
 */
async function drive(
  depth: number,
  script: ReadonlyArray<{ phase: string; tokens: number; idleMs?: number }>,
): Promise<Bill[]> {
  const prepare = await stepOf();
  const provider = prefixProvider();
  let history = preamble(depth);
  let at = T0;
  for (const [i, step] of script.entries()) {
    at += STEP_MS + (step.idleMs ?? 0);
    const out = await prepare({ messages: history, responseMessages: [], steps: [{ usage: { inputTokens: 0 } }] });
    provider.bill(out.messages ?? history, at, step.phase);
    history = [...history, call(i), result(i, step.tokens * 4)];
  }
  return provider.bills;
}

/** Every call the provider could have matched, it matched. */
function expectUnbrokenPrefix(bills: Bill[]): void {
  for (const b of bills.filter((b) => !b.cold)) {
    expect({ at: b.phase, shared: b.shared, msgs: b.msgs }).toEqual({ at: b.phase, shared: b.msgs - 2, msgs: b.msgs });
  }
}

describe("the prefix across the compaction line", () => {
  it("keeps the head of the view while the chat rides the line", async () => {
    // 95K of history, then a turn that grows 800 tokens a step: the view walks
    // up to the line and hovers over it, the way it did from 14:08 to 14:27.
    const script = [
      { phase: "старт", tokens: 800 },
      { phase: "старт", tokens: 800 },
      { phase: "старт", tokens: 800 },
      // The pause: the provider's own TTL empties the cache, and this one call
      // pays for the whole view. Expected, and the only one of its kind.
      { phase: "простой", tokens: 800, idleMs: 2 * TTL_MS },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
      { phase: "у линии", tokens: 800 },
    ];
    const bills = await drive(95_000, script);

    // Two calls cannot come from a cache, both for the provider's own reasons:
    // the first call ever, and the one that breaks the pause.
    expect(bills.filter((b) => b.cold).map((b) => b.phase)).toEqual(["старт", "простой"]);
    expectUnbrokenPrefix(bills);

    const paid = bills.filter((b) => !b.cold);
    const input = paid.reduce((s, b) => s + b.input, 0);
    const cached = paid.reduce((s, b) => s + b.cached, 0);
    expect(cached / input).toBeGreaterThan(0.97);

    // The line is where the losses clustered, so it says so itself: past it,
    // every call still opens with the view the provider already has.
    const near = paid.filter((b) => b.input > LINE * 0.95);
    expect(near.length).toBeGreaterThan(3);
    expect(near.every((b) => b.shared === b.msgs - 2)).toBe(true);
  });

  it("lets the view run past the line without touching its head", async () => {
    // Steps of 5K against a 100K line: the view crosses it and keeps going. The
    // history is rewritten at compaction, not here — so nothing breaks.
    const script = Array.from({ length: 8 }, () => ({ phase: "за линией", tokens: 5_000 }));
    const bills = await drive(90_000, script);

    expectUnbrokenPrefix(bills);
    expect(bills.some((b) => b.input > LINE * 1.25)).toBe(true);
    // Only the step's own new messages are billed at full price — the 5K the
    // step added, not the hundred the view already carries.
    expect(bills.every((b) => b.cold || b.input - b.cached < 6_000)).toBe(true);
  });
});
