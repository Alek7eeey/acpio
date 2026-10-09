import type { AppLocale, MessagePartDto } from "@acpio/shared";
import type { TranslateFn } from "@acpio/i18n";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Wall-clock each part occupied, keyed by part id.
 *
 * A part starts at its own `createdAt` and ends where the next part starts,
 * because a harness only emits the next chunk once the current one is done —
 * that is what makes per-thought and per-tool timings recoverable from a
 * reloaded transcript, which stores no end time at all.
 *
 * The trailing part has no successor. While the turn is live `now` bounds it
 * (and the number keeps growing); once the turn is over it is left untimed
 * rather than guessed. Note that `payload.durationMs` on thoughts is the whole
 * turn's ACP request time — the server stamps the same value on every thought —
 * so it is deliberately not used here.
 *
 * A question part is a hard boundary, not agent work: its span is however long
 * the user takes, and a parked turn accrues no time at all. So a still-unanswered
 * question ends the measured stretch — nothing past it is timed (that work has
 * not happened yet) and `now` never bounds anything while it waits. Without
 * this the block's header kept counting up while the reader was deciding.
 */
export function partDurations(
  parts: MessagePartDto[],
  opts?: { now?: number },
): Map<string, number> {
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const parkIndex = sorted.findIndex(
    (p) => p.type === "question" && Boolean(p.payload.pending),
  );
  const stretch = parkIndex >= 0 ? sorted.slice(0, parkIndex) : sorted;
  const parkAt = parkIndex >= 0 ? Date.parse(sorted[parkIndex]!.createdAt) : undefined;

  const durations = new Map<string, number>();
  for (let i = 0; i < stretch.length; i += 1) {
    const part = stretch[i]!;
    if (part.type === "question") continue;
    const start = Date.parse(part.createdAt);
    if (!Number.isFinite(start)) continue;
    const next = stretch[i + 1];
    const end = next ? Date.parse(next.createdAt) : (parkAt ?? opts?.now);
    if (end == null || !Number.isFinite(end)) continue;
    durations.set(part.id, Math.max(0, end - start));
  }
  return durations;
}

/** Sum of the given parts' measured spans (0 when none of them is timed). */
export function sumDurations(
  parts: MessagePartDto[],
  durations: Map<string, number>,
): number {
  let total = 0;
  for (const part of parts) total += durations.get(part.id) ?? 0;
  return total;
}

/**
 * Compact span for a spoiler header: `0,4 с`, `3,7 с`, `42 с`, `1 мин 12 с`.
 * Sub-10-second spans keep one decimal — most tool calls live there, and
 * rounding them all to "1 с" would flatten the difference between a 200 ms read
 * and a 4 s build. Empty string for an unmeasurable span, so callers omit it.
 */
export function formatDuration(ms: number, locale: AppLocale, t: TranslateFn): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const num = (value: number, digits: number) =>
    value.toLocaleString(locale, { maximumFractionDigits: digits });
  if (ms < MINUTE) {
    const seconds = ms / SECOND;
    const digits = seconds < 10 ? 1 : 0;
    // The display resolution under ten seconds is 0.1 s. A span that rounds to
    // zero is not shown at all: harnesses issue parallel tool calls whose parts
    // start milliseconds apart, and the first of the batch would otherwise
    // print "0s" beside a call the reader watched run for a second.
    if (Number(seconds.toFixed(digits)) === 0) return "";
    return t("common.durationSec", { value: num(seconds, digits) });
  }
  const whole = Math.floor(ms / SECOND);
  if (ms >= HOUR) return t("common.durationMin", { value: num(Math.floor(whole / 60), 0) });
  return t("common.durationMinSec", {
    value: num(Math.floor(whole / 60), 0),
    seconds: num(whole % 60, 0),
  });
}
