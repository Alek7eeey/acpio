import { RingBuffer } from "./lib/ring.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const rb = new RingBuffer(3);
rb.push("a").push("b").push("c");
if (!eq(rb.contents(), ["a", "b", "c"])) fail("fill order: " + JSON.stringify(rb.contents()));
rb.push("d");
if (!eq(rb.contents(), ["b", "c", "d"])) fail("one wrap evicts the oldest: " + JSON.stringify(rb.contents()));
rb.push("e").push("f");
if (!eq(rb.contents(), ["d", "e", "f"])) fail("two wraps: " + JSON.stringify(rb.contents()));
if (rb.size !== 3) fail("size stays at capacity");

const one = new RingBuffer(1);
one.push("x").push("y");
if (!eq(one.contents(), ["y"])) fail("capacity one keeps the newest");

const snap = rb.contents();
snap.push("junk");
if (rb.contents().length !== 3) fail("contents returns a copy");

throws(() => new RingBuffer(0), "zero capacity");
throws(() => new RingBuffer(2.5), "fractional capacity");

console.log("PASS: wrap-around evicts the oldest, the timeline stays in order");
