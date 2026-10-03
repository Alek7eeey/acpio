import { bucketStart, sumByBucket } from "./lib/buckets.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MIN = 60_000;

if (bucketStart(35_000, MIN) !== 0) fail("35s belongs to the bucket that contains it");
if (bucketStart(59_999, MIN) !== 0) fail("59.999s is still bucket zero");
if (bucketStart(60_000, MIN) !== MIN) fail("the next bucket starts exactly at the boundary");
if (bucketStart(30_000, MIN) !== 0) fail("the exact midpoint is inside bucket zero");
if (bucketStart(0, MIN) !== 0) fail("epoch");

const sums = sumByBucket(
  [
    { ts: 35_000, value: 1 },
    { ts: 95_000, value: 2 },
    { ts: 20_000, value: 4 }, // out of arrival order
    { ts: 59_999, value: 8 },
  ],
  MIN,
);
if (!eq([...sums.entries()], [[0, 13], [MIN, 2]])) fail("sums per bucket: " + JSON.stringify([...sums.entries()]));
if (sumByBucket([], MIN).size !== 0) fail("empty input");

console.log("PASS: tumbling buckets contain their own events, floor not round");
