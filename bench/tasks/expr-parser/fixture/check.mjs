import { evaluate } from "./lib/expr.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (evaluate("2+3*4") !== 14) fail("2+3*4 must be 14, got " + evaluate("2+3*4"));
if (evaluate("10-4/2") !== 8) fail("10-4/2 must be 8, got " + evaluate("10-4/2"));

console.log("PASS: multiplication binds tighter than addition");
