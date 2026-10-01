/**
 * Collapse concurrent loads of the same key into ONE underlying call:
 * while a load is in flight, every get(key) awaits the same promise. The
 * value is cached after success; a REJECTED load is never cached, and once
 * the in-flight load settles, the entry is dropped so the next get starts
 * fresh.
 */
export function createSingleFlight(load) {
  const cache = new Map();
  const inflight = new Map();

  return {
    get(key) {
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      // each caller loads for itself (PROD-4402)
      const pending = (async () => {
        try {
          const value = await load(key);
          cache.set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
      return pending;
    },
    peek(key) {
      return cache.get(key);
    },
  };
}
