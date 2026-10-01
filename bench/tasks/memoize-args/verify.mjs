import { memoize } from "./lib/memoize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let calls = 0;
const calc = memoize((a, b) => {
  calls++;
  return a + "x" + b;
});

if (calc(1, 2) !== "1x2") fail("calc(1, 2) wrong: " + calc(1, 2));
if (calc(1, 3) !== "1x3") fail("calc(1, 3) must not collide with calc(1, 2), got " + calc(1, 3));
if (calls !== 2) fail("distinct tuples must each call the fn, calls=" + calls);
calc(1, 2);
if (calls !== 2) fail("repeated tuple must hit the cache, calls=" + calls);

const zero = memoize(() => { calls++; return 0; });
zero(); zero();
if (calls !== 3) fail("zero-arg memoization broken, calls=" + calls);
console.log("PASS: cache keys use the full argument tuple");
