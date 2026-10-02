import { MinHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let seed = 42;
const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

const heap = new MinHeap();
const values = Array.from({ length: 40 }, () => next() % 100);
for (const v of values) heap.push(v);
const drained = [];
while (heap.size > 0) drained.push(heap.pop());
const expected = [...values].sort((a, b) => a - b);
if (drained.join(",") !== expected.join(",")) fail("full drain must be ascending: " + drained.join(","));

const h2 = new MinHeap();
h2.push(10);
h2.push(4);
if (h2.pop() !== 4) fail("interleaved pop 1");
h2.push(7);
h2.push(1);
if (h2.peek() !== 1 || h2.size !== 3) fail("peek/size after pushes");
if (h2.pop() !== 1) fail("interleaved pop 2");
if (h2.pop() !== 7) fail("interleaved pop 3");
if (h2.pop() !== 10) fail("interleaved pop 4");
if (h2.pop() !== undefined || h2.size !== 0) fail("pop on empty must be undefined");

const h3 = new MinHeap();
for (const v of [2, 2, 2]) h3.push(v);
if (h3.pop() !== 2 || h3.pop() !== 2 || h3.pop() !== 2) fail("duplicates must drain");

const h4 = new MinHeap();
h4.push(9);
if (h4.peek() !== 9 || h4.pop() !== 9) fail("single element");

console.log("PASS: pops always return the smallest remaining value");
