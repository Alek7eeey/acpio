import { createTokenBucket } from "./lib/bucket.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, now: () => t });

for (let i = 0; i < 5; i++) {
  if (!bucket.take().allowed) fail("a fresh bucket must allow 5 takes, failed at " + i);
}
if (bucket.take().allowed) fail("an empty bucket must block");
const blocked = bucket.take(2);
if (blocked.allowed || blocked.retryAfterMs !== 2000) fail("retryAfterMs must cover 2 missing tokens: " + JSON.stringify(blocked));

t = 600_000; // ten idle minutes
if (bucket.tokens !== 5) fail("idle time must refill to capacity, not past it: " + bucket.tokens);
let granted = 0;
while (bucket.take().allowed) granted++;
if (granted !== 5) fail("after idle the bucket must grant exactly capacity tokens, granted " + granted);

t += 2500; // 2.5 tokens back
if (!bucket.take(2).allowed) fail("2 tokens must be available after 2.5s of refill");
const tight = bucket.take(2);
if (tight.allowed || tight.retryAfterMs !== 1500) fail("a half-refilled bucket must report the missing half second: " + JSON.stringify(tight));

for (const bad of [0, -1, 1.5]) {
  let threw = false;
  try { bucket.take(bad); } catch { threw = true; }
  if (!threw) fail("take(" + bad + ") must throw");
}
let threw = false;
try { createTokenBucket({ capacity: 0, refillPerSec: 1 }); } catch { threw = true; }
if (!threw) fail("capacity must be a positive integer");
threw = false;
try { createTokenBucket({ capacity: 5, refillPerSec: -1 }); } catch { threw = true; }
if (!threw) fail("refillPerSec must be positive");

console.log("PASS: refill caps at capacity; take reports honest retries");
