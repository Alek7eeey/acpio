/**
 * TTL cache: an entry lives `ttl` ms from its SET — reads never extend it.
 * The clock is injectable so expiry is testable without real waiting.
 */
export function createTtlCache({ ttl, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError("ttl must be a positive number of ms");
  const map = new Map();
  const alive = (entry, at) => at < entry.expiresAt;
  return {
    set(key, value) {
      map.set(key, { value, expiresAt: now() + ttl });
    },
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      entry.expiresAt = now() + ttl; // reads keep hot entries alive
      return entry.value;
    },
    has(key) {
      const entry = map.get(key);
      return !!entry && alive(entry, now());
    },
    purge() {
      const t = now();
      for (const [key, entry] of map) {
        if (!alive(entry, t)) map.delete(key);
      }
      return map.size;
    },
    get size() {
      const t = now();
      let n = 0;
      for (const entry of map.values()) {
        if (alive(entry, t)) n++;
      }
      return n;
    },
  };
}
