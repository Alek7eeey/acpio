import { MinHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new MinHeap();
for (const n of [5, 3, 8, 1, 9, 2]) heap.push(n);
const drained = [];
while (heap.size > 0) drained.push(heap.pop());
if (drained.join(",") !== "1,2,3,5,8,9") fail("drain must be ascending, got " + drained.join(","));

console.log("PASS: the queue drains ascending");
