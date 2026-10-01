import { createTtlCache } from "./lib/ttl.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const cache = createTtlCache({ ttl: 100, now: () => t });
cache.set("a", 1);
if (cache.get("a") !== 1) fail("fresh entry must be readable");
if (cache.size !== 1) fail("size must count a live entry");
t = 90;
if (cache.get("a") !== 1) fail("entry must live until ttl after its set");
t = 150;
if (cache.get("a") !== undefined) fail("reads must NOT extend the ttl: entry expired at 100");
if (cache.has("a")) fail("has must respect expiry");
if (cache.size !== 0) fail("size must not count expired entries, got " + cache.size);

cache.set("b", 2);
if (cache.purge() !== 1) fail("purge must keep live entries");
t = 300;
if (cache.purge() !== 0) fail("purge must drop expired entries");

cache.set("c", 3);
t = 350;
cache.set("c", 4);
if (cache.get("c") !== 4) fail("overwrite must keep the value");
t = 420;
if (cache.get("c") !== 4) fail("ttl must run from the overwrite, not the first set");
t = 460;
if (cache.get("c") !== undefined) fail("overwritten entry must expire 100ms after the overwrite");

let threw = false;
try { createTtlCache({ ttl: 0 }); } catch { threw = true; }
if (!threw) fail("ttl must be a positive number");

console.log("PASS: ttl runs from set, reads do not extend it");
