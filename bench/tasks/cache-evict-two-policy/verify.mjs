import { TtlLruCache } from "./lib/cache.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

// expired entry must be purged before a live one is evicted
let t = 0;
const cache = new TtlLruCache({ capacity: 2, ttlMs: 100, now: () => t });
cache.set("k1", 1); // t=0, expires at 100
t = 10;
cache.set("k2", 2); // expires at 110
t = 20;
if (cache.get("k1") !== 1) fail("k1 is fresh and must be readable");
// recency order is now k2 (oldest), k1 (just used)
t = 105; // k1 expired (100 <= 105), k2 still fresh (110 > 105)
cache.set("k3", 3);
if (!cache.has("k2")) fail("live k2 was evicted while expired k1 could go: has(k2)=" + cache.has("k2"));
if (cache.get("k1") !== undefined) fail("expired k1 must be invisible");
if (cache.get("k3") !== 3) fail("k3 must be readable");
if (cache.size !== 2) fail("two fresh entries after the dust settles: " + cache.size);

// everything fresh -> plain LRU
t = 0;
const lru = new TtlLruCache({ capacity: 2, ttlMs: 1000, now: () => t });
lru.set("a", 1);
lru.set("b", 2);
t = 1;
lru.get("a"); // bump a; b is now LRU
lru.set("c", 3);
if (lru.has("b")) fail("b was LRU and had to go");
if (lru.get("a") !== 1 || lru.get("c") !== 3) fail("a and c survive");

// has() does not bump recency
t = 0;
const h = new TtlLruCache({ capacity: 2, ttlMs: 1000, now: () => t });
h.set("a", 1);
h.set("b", 2);
t = 3;
h.has("a"); // must NOT bump
h.set("c", 3);
if (h.has("a")) fail("a is LRU (has() must not bump recency)");
if (h.get("b") !== 2) fail("b must survive");

// expired get() purges
t = 0;
const p = new TtlLruCache({ capacity: 2, ttlMs: 10, now: () => t });
p.set("x", 1);
t = 11;
if (p.get("x") !== undefined) fail("expired entry invisible");
if (p.size !== 0) fail("expired entry purged on read: " + p.size);

throws(() => new TtlLruCache({ capacity: 0, ttlMs: 10, now: () => 0 }), "bad capacity");
throws(() => new TtlLruCache({ capacity: 2, ttlMs: 0, now: () => 0 }), "bad ttl");
throws(() => new TtlLruCache({ capacity: 2, ttlMs: 10, now: 5 }), "clock required");

console.log("PASS: stale entries go first, live entries are never evicted past them");
