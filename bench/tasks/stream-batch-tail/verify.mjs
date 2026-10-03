import { runBatch } from "./lib/batcher.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
async function* src(n) {
  for (let i = 0; i < n; i++) yield i;
}

const batches = [];
const pushed = await runBatch(src(237), async (b) => batches.push(b), 100);
if (pushed !== 237) fail("all 237 items must reach the sink, got " + pushed);
if (batches.length !== 3) fail("three batches: 100, 100, 37 — got " + batches.length);
if (batches[0].length !== 100 || batches[1].length !== 100) fail("full batches are exactly 100");
if (batches[2].length !== 37) fail("the tail arrives as one final batch of 37: " + batches[2].length);
if (batches[2][0] !== 200 || batches[2][36] !== 236) fail("tail holds rows 200..236 in order");
const flat = batches.flat();
for (let i = 0; i < 237; i++) {
  if (flat[i] !== i) fail("order preserved across batches, broke at " + i);
}

const exact = [];
const pushedExact = await runBatch(src(4), async (b) => exact.push(b), 2);
if (pushedExact !== 4 || exact.length !== 2 || exact[1].length !== 2) fail("exact multiple leaves no empty tail");

const none = [];
const pushedNone = await runBatch(src(0), async (b) => none.push(b), 5);
if (pushedNone !== 0 || none.length !== 0) fail("empty source pushes nothing");

let threw = false;
try {
  await runBatch(src(1), async () => {}, 0);
} catch {
  threw = true;
}
if (!threw) fail("non-positive size must throw");

console.log("PASS: the tail always reaches the sink, nothing is dropped");
