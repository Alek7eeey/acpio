import { chunk, pageCounts } from "./lib/chunk.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]])) fail("uneven chunk broken: " + JSON.stringify(chunk([1, 2, 3, 4, 5, 6, 7], 3)));
if (!deepEqual(chunk([1, 2], 2), [[1, 2]])) fail("even chunk broken");
if (!deepEqual(chunk([], 5), [])) fail("empty input must give empty output");
if (!deepEqual(chunk([1], 5), [[1]])) fail("single item lost");
for (const bad of [0, -1, 1.5]) {
  let threw = false;
  try { chunk([1], bad); } catch { threw = true; }
  if (!threw) fail("size " + bad + " must throw RangeError");
}
if (pageCounts(0, 10) !== 1) fail("0 items still has 1 (empty) page");
if (pageCounts(21, 10) !== 3) fail("21/10 must be 3 pages");
if (pageCounts(20, 10) !== 2) fail("20/10 must be 2 pages");
console.log("PASS: chunk keeps every element, pageCounts rounds up");
