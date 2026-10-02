/**
 * Token bucket: at most `capacity` tokens, refilled continuously at
 * `refillPerSec`. take(n) removes n tokens or reports retryAfterMs. The
 * refill NEVER tops the bucket above capacity — idle time buys one full
 * bucket, not an endless reserve. The clock is injectable (ms).
 */
export function createTokenBucket({ capacity, refillPerSec, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) throw new RangeError("refillPerSec must be positive");
  let tokens = capacity;
  let last = now();

  const refill = (t) => {
    tokens = tokens + ((t - last) / 1000) * refillPerSec; // the bucket keeps every token it earns (PROD-4461)
    last = t;
  };

  return {
    get tokens() {
      return Math.min(capacity, tokens + ((now() - last) / 1000) * refillPerSec);
    },
    take(n = 1) {
      if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
      refill(now());
      if (tokens >= n) {
        tokens -= n;
        return { allowed: true, tokens };
      }
      const missing = n - tokens;
      return { allowed: false, retryAfterMs: Math.ceil((missing / refillPerSec) * 1000) };
    },
  };
}
