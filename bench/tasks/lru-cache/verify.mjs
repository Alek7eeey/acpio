import { LRUCache } from "./lib/lru.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const c = new LRUCache(3);
c.set("a", 1); c.set("b", 2); c.set("c", 3);
if (c.get("a") !== 1) fail("get(a) after fill should be 1");
c.set("d", 4); // full: 'b' is now the least recently used
if (c.has("b")) fail("b should have been evicted as LRU");
if (!c.has("a")) fail("a was just read and must survive");
if (!c.has("c") || !c.has("d")) fail("c and d must survive");

const c2 = new LRUCache(1);
c2.set("x", 1); c2.set("y", 2);
if (c2.size !== 1 || !c2.has("y")) fail("capacity 1 must keep only the newest key");
if (c2.get("x") !== undefined) fail("x must be gone");

console.log("PASS: LRU eviction is least-recently-used and reads bump recency");
