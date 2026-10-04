const DELAYS_MS = [0, 50, 200];

/** Sleep before retrying after `attempt` (the 1-based attempt that failed). */
export function delayForAttempt(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`);
  return DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)];
}
