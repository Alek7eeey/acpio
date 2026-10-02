/**
 * Pure schedule math for recurring jobs. All times are in ms on the
 * caller's clock. A job registered at startMs with intervalMs is due at
 * startMs + k * intervalMs for k = 1, 2, 3... — a firing's scheduled time
 * NEVER moves, no matter how long any single run takes.
 */
export function firstDue(startMs, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("intervalMs must be positive");
  return startMs + intervalMs;
}

/** How many firings are due at nowMs when the firing scheduled at
 * lastScheduled already ran: every full interval after it. */
export function dueCount(lastScheduled, intervalMs, nowMs) {
  if (nowMs < lastScheduled) return 0;
  return Math.floor((nowMs - lastScheduled) / intervalMs);
}
