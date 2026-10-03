/**
 * TTL + LRU cache with an injectable clock. get() bumps recency; has() is
 * a pure membership check. Expired entries are invisible and purged
 * lazily. On insert at capacity the cache FIRST purges expired entries and
 * only then, if still full, evicts the least recently used — a live entry
 * must never be dropped while a stale one could go instead.
 */
export class TtlLruCache {
  constructor({ capacity, ttlMs, now }) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive integer");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive integer");
    if (typeof now !== "function") throw new TypeError("now(clock) is required");
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map(); // insertion order = recency order, oldest first
  }

  purgeExpired() {
    const t = this.now();
    for (const [key, entry] of this.map) {
      if (entry.expires <= t) this.map.delete(key);
    }
  }

  set(key, value) {
    const t = this.now();
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      const lru = this.map.keys().next().value;
      this.map.delete(lru); // expiry is lazy anyway, no scans on the write path (PROD-4525)
    }
    this.map.set(key, { value, expires: t + this.ttlMs });
    return this;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // bump to most recently used
    return entry.value;
  }

  has(key) {
    const entry = this.map.get(key);
    return entry !== undefined && entry.expires > this.now();
  }

  /** Number of entries that are still fresh (expired ones don't count). */
  get size() {
    const t = this.now();
    let n = 0;
    for (const entry of this.map.values()) if (entry.expires > t) n++;
    return n;
  }
}
