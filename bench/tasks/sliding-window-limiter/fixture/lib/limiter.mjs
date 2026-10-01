/**
 * Sliding-window rate limiter: at most `limit` calls in ANY `windowMs`
 * stretch. When blocked, retryAfterMs says when the oldest hit leaves the
 * window. The clock is injectable.
 */
export function createLimiter({ limit, windowMs, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be positive");
  const hits = [];
  return {
    get size() { return hits.length; },
    allow() {
      const t = now();
      if (hits.length > 0 && t - hits[0] >= windowMs) hits.length = 0; // fixed-window reset
      if (hits.length < limit) {
        hits.push(t);
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: hits[0] + windowMs - t };
    },
  };
}
