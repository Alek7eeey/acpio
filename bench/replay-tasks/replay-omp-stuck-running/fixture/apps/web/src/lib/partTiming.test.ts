import { describe, expect, it } from "vitest";
import type { MessagePartDto } from "@acpio/shared";
import type { TranslateFn } from "@acpio/i18n";
import { formatDuration, partDurations, sumDurations } from "./partTiming.js";

const base = Date.parse("2026-01-01T00:00:00.000Z");

function part(
  type: MessagePartDto["type"],
  order: number,
  offsetMs: number,
  payload: Record<string, unknown> = {},
): MessagePartDto {
  return {
    id: `${type}-${order}`,
    messageId: "m1",
    type,
    order,
    payload,
    createdAt: new Date(base + offsetMs).toISOString(),
  };
}

/** Stands in for the ru catalog so assertions read like the UI. */
const t: TranslateFn = (key, vars) => {
  const value = vars?.value ?? "";
  if (key === "common.durationSec") return `${value} с`;
  if (key === "common.durationMin") return `${value} мин`;
  if (key === "common.durationMinSec") return `${value} мин ${vars?.seconds} с`;
  return key;
};

describe("partDurations", () => {
  // The captured omp stream: tool → thought → tool → thought → text. Every span
  // is recoverable because the next part only starts once the previous finished.
  it("times each part up to the start of the next one", () => {
    const parts = [
      part("tool_call", 0, 0),
      part("thought", 1, 1500),
      part("tool_call", 2, 5200),
      part("text", 3, 6800),
    ];
    const durations = partDurations(parts);
    expect(durations.get("tool_call-0")).toBe(1500);
    expect(durations.get("thought-1")).toBe(3700);
    expect(durations.get("tool_call-2")).toBe(1600);
  });

  // A reloaded transcript has no end time for the trailing part; inventing one
  // would print a number that grows with every page load.
  it("leaves the trailing part untimed once the turn is over", () => {
    const parts = [part("thought", 0, 0), part("text", 1, 2000)];
    const durations = partDurations(parts);
    expect(durations.has("thought-0")).toBe(true);
    expect(durations.has("text-1")).toBe(false);
    expect(sumDurations(parts, durations)).toBe(2000);
  });

  it("bounds the trailing part by `now` while the turn is live", () => {
    const parts = [part("thought", 0, 0), part("text", 1, 2000)];
    const durations = partDurations(parts, { now: base + 6000 });
    expect(durations.get("text-1")).toBe(4000);
    expect(sumDurations(parts, durations)).toBe(6000);
  });

  // The live parked turn: the harness drops an error row next to the question
  // (the ask tool itself) and the session stays "waiting" for as long as the
  // reader thinks. Nothing may accrue in the meantime.
  it("freezes the measured stretch at a still-unanswered question", () => {
    const parts = [
      part("thought", 0, 0),
      part("question", 1, 800, { requestId: "q1", pending: true }),
      part("tool_call", 2, 900),
    ];
    const early = partDurations(parts, { now: base + 10000 });
    const late = partDurations(parts, { now: base + 300000 });
    expect(early.get("thought-0")).toBe(800);
    // Neither the ask row (past the question) nor the question itself is timed.
    expect(early.has("tool_call-2")).toBe(false);
    expect(early.has("question-1")).toBe(false);
    expect(sumDurations(parts, early)).toBe(800);
    expect(sumDurations(parts, late)).toBe(800);
  });

  // An earlier question that was answered is not a barrier — its own wait stays
  // untimed, but the work after it still counts.
  it("keeps timing the parts that follow an answered question", () => {
    const parts = [
      part("thought", 0, 0),
      part("question", 1, 1000, { requestId: "q1", pending: false }),
      part("tool_call", 2, 40000),
      part("text", 3, 43000),
    ];
    const durations = partDurations(parts, { now: base + 45000 });
    expect(durations.has("question-1")).toBe(false);
    // The 39s the user spent answering belong to nobody: the tool starts fresh.
    expect(durations.get("tool_call-2")).toBe(3000);
    expect(durations.get("text-3")).toBe(2000);
  });

  // A neighbour with an unusable timestamp also removes the span that would end
  // there — better a missing chip than a bogus one. Later parts stay timed.
  it("leaves spans untimed around a part whose createdAt is unusable", () => {
    const parts = [
      part("thought", 0, 0),
      { ...part("tool_call", 1, 1000), createdAt: "not-a-date" },
      part("thought", 2, 2000),
      part("text", 3, 3000),
    ];
    const durations = partDurations(parts);
    expect(durations.get("thought-0")).toBeUndefined();
    expect(durations.get("tool_call-1")).toBeUndefined();
    expect(durations.get("thought-2")).toBe(1000);
  });

  it("orders by `order`, not by array position", () => {
    const parts = [part("text", 1, 2000), part("thought", 0, 0)];
    expect(partDurations(parts).get("thought-0")).toBe(2000);
  });
});

describe("formatDuration", () => {
  it("keeps a decimal for sub-10-second spans", () => {
    expect(formatDuration(400, "ru", t)).toBe("0,4 с");
    expect(formatDuration(3700, "ru", t)).toBe("3,7 с");
  });

  it("drops the decimal from ten seconds up", () => {
    expect(formatDuration(42_400, "ru", t)).toBe("42 с");
  });

  it("splits minutes and seconds", () => {
    expect(formatDuration(72_000, "ru", t)).toBe("1 мин 12 с");
  });

  it("counts whole minutes past an hour", () => {
    expect(formatDuration(3_780_000, "ru", t)).toBe("63 мин");
  });

  // Nothing to show is not the same as "0 с": callers omit the chip entirely.
  it("returns an empty string when there is no span to show", () => {
    expect(formatDuration(0, "ru", t)).toBe("");
    expect(formatDuration(Number.NaN, "ru", t)).toBe("");
    expect(formatDuration(-5, "ru", t)).toBe("");
  });

  // Parallel tool calls start milliseconds apart (omp issues them in batches),
  // so the first of a batch measures ~0 and must not print "0 с" next to a call
  // the reader watched run for a second.
  it("hides spans below the display resolution", () => {
    expect(formatDuration(1, "ru", t)).toBe("");
    expect(formatDuration(40, "ru", t)).toBe("");
    expect(formatDuration(120, "ru", t)).toBe("0,1 с");
  });
});
