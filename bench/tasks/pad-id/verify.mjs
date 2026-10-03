import { formatOrderId } from "./lib/id.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

if (formatOrderId(42) !== "ORD-000042") fail("small ids pad to six");
if (formatOrderId(0) !== "ORD-000000") fail("zero pads to six");
if (formatOrderId(999999) !== "ORD-999999") fail("exactly six digits stay six");
if (formatOrderId(1000000) !== "ORD-1000000") fail("a million keeps all seven digits: " + formatOrderId(1000000));
if (formatOrderId(12345678) !== "ORD-12345678") fail("eight digits keep all eight");
throws(() => formatOrderId(-1), "negative seq");
throws(() => formatOrderId(4.2), "fractional seq");

console.log("PASS: six digits is a floor, ids never collide by truncation");
