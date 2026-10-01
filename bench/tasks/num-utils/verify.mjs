import { clamp, lerp, roundTo } from "./lib/num.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (clamp(5, 0, 10) !== 5) fail("clamp in-range");
if (clamp(-3, 0, 10) !== 0) fail("clamp low");
if (clamp(42, 0, 10) !== 10) fail("clamp high");
if (clamp(5, 10, 0) !== 5) fail("clamp must normalize swapped bounds");

if (lerp(0, 10, 0.25) !== 2.5) fail("lerp mid");
if (lerp(10, 20, 0.5) !== 15) fail("lerp offset range");
if (lerp(0, 10, -0.5) !== 0) fail("lerp must clamp t < 0, got " + lerp(0, 10, -0.5));
if (lerp(0, 10, 1.5) !== 10) fail("lerp must clamp t > 1, got " + lerp(0, 10, 1.5));
if (lerp(3, 3, 0.7) !== 3) fail("lerp degenerate range");

if (roundTo(2.5) !== 3) fail("roundTo half up");
if (roundTo(-2.5) !== -3) fail("roundTo half away from zero, got " + roundTo(-2.5));
if (roundTo(1.2345, 2) !== 1.23) fail("roundTo digits, got " + roundTo(1.2345, 2));
if (roundTo(9.127, 1) !== 9.1) fail("roundTo one digit");

console.log("PASS: clamp/lerp/roundTo behave at the edges");
