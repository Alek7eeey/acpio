import { wrap } from "./lib/wrap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["The quick brown fox", 9, "The quick\nbrown fox"],
  ["hello world", 11, "hello world"],
  ["a b c", 1, "a\nb\nc"],
  ["abcdefghij", 5, "abcdefghij"],
  ["hello   world", 5, "hello\nworld"],
  ["x\ny z", 10, "x\ny z"],
  ["", 5, ""],
];
for (const [input, width, expected] of cases) {
  const got = wrap(input, width);
  if (got !== expected) fail("wrap(" + JSON.stringify(input) + ", " + width + ") -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
}
let threw = false;
try { wrap("x", 0); } catch { threw = true; }
if (!threw) fail("width 0 must throw");

console.log("PASS: greedy wrap fills lines exactly to the width");
