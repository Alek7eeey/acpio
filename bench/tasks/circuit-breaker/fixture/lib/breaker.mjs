/**
 * Circuit breaker around async calls.
 * closed — calls pass through; `threshold` consecutive failures open the
 *   circuit; any success resets the failure counter.
 * open — every call throws Error("circuit open") WITHOUT invoking the
 *   delegate; after `cooldownMs` since opening, the circuit turns
 *   half-open.
 * half-open — exactly ONE probe call may run; its success closes the
 *   circuit, its failure reopens it with a fresh cooldown. Every other
 *   call during half-open throws Error("circuit open").
 * The clock is injectable.
 */
export function createBreaker({ threshold = 3, cooldownMs = 30_000, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("threshold must be a positive integer");
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new RangeError("cooldownMs must be positive");
  let state = "closed";
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  return {
    get state() { return state; },
    async call(fn) {
      if (state === "open" && now() - openedAt >= cooldownMs) {
        state = "half-open";
        probing = false;
      }
      if (state === "open") throw new Error("circuit open");
      if (state === "half-open") {
        // half-open lets traffic through again
        probing = true;
        try {
          const value = await fn();
          state = "closed";
          failures = 0;
          probing = false;
          return value;
        } catch (err) {
          state = "open";
          openedAt = now();
          probing = false;
          throw err;
        }
      }
      try {
        const value = await fn();
        failures = 0;
        return value;
      } catch (err) {
        failures++;
        if (failures >= threshold) {
          state = "open";
          openedAt = now();
        }
        throw err;
      }
    },
  };
}
