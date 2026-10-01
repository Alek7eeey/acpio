import { runPool } from "./lib/pool.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let inFlight = 0;
let maxInFlight = 0;
const items = Array.from({ length: 12 }, (_, i) => i);
const results = await runPool(items, 3, async (n) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
  inFlight--;
  return n * 2;
});
if (maxInFlight > 3) fail("observed " + maxInFlight + " concurrent tasks, limit is 3");
if (maxInFlight !== 3) fail("pool underutilised: max " + maxInFlight + " of limit 3");
if (results.length !== 12 || results.some((v, i) => v !== i * 2)) fail("results wrong or unordered: " + JSON.stringify(results));

try {
  await runPool([1], 2, async () => { throw new Error("boom"); });
  fail("worker error must reject the pool");
} catch (err) {
  if (err.message !== "boom") fail("wrong rejection: " + err.message);
}
console.log("PASS: pool respects the concurrency limit, keeps order, propagates errors");
