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
if (results.length !== 12 || results.some((v, i) => v !== i * 2)) fail("results wrong or unordered: " + JSON.stringify(results));
const empty = await runPool([], 3, async () => 1);
if (empty.length !== 0) fail("empty input should give empty output");
console.log("PASS: pool respects the concurrency limit and keeps order");
