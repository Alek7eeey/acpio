import { parseDuration } from "./lib/duration.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["90s", 90000],
  ["500ms", 500],
  ["1m", 60000],
  ["1m30s", 90000],
  ["1h30m", 5400000],
  ["2d", 172800000],
  ["1h 30m", 5400000],
  ["0ms", 0],
  ["1500", 1500],
];
for (const [input, expected] of cases) {
  const got = parseDuration(input);
  if (got !== expected) fail("parseDuration(" + JSON.stringify(input) + ") -> " + got + ", expected " + expected);
}
for (const bad of ["", "abc", "1x", "1h30", "-5s", "m"]) {
  let threw = false;
  try { parseDuration(bad); } catch { threw = true; }
  if (!threw) fail("parseDuration(" + JSON.stringify(bad) + ") must throw");
}

console.log("PASS: durations parse with the documented unit table");
