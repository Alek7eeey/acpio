import { mergeIntervals, totalCovered } from "./lib/intervals.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(mergeIntervals([{ start: 0, end: 2 }, { start: 2, end: 4 }]), [{ start: 0, end: 4 }])) {
  fail("touching ranges must merge: " + JSON.stringify(mergeIntervals([{ start: 0, end: 2 }, { start: 2, end: 4 }])));
}
if (!eq(mergeIntervals([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 2, end: 6 }]), [{ start: 0, end: 8 }])) fail("overlap + containment must merge");
if (!eq(mergeIntervals([{ start: 0, end: 1 }, { start: 5, end: 6 }]), [{ start: 0, end: 1 }, { start: 5, end: 6 }])) fail("disjoint ranges must stay");
if (!eq(mergeIntervals([{ start: 0, end: 10 }, { start: 2, end: 3 }]), [{ start: 0, end: 10 }])) fail("containment must keep the outer end");
if (!eq(mergeIntervals([]), [])) fail("empty input");
const input = [{ start: 1, end: 2 }];
mergeIntervals(input);
if (!eq(input, [{ start: 1, end: 2 }])) fail("input must not be mutated");
if (totalCovered([{ start: 0, end: 10 }, { start: 5, end: 6 }, { start: 20, end: 25 }]) !== 15) fail("totalCovered must merge before summing");
if (totalCovered([]) !== 0) fail("totalCovered empty");

console.log("PASS: ranges merge on touch, input stays intact");
