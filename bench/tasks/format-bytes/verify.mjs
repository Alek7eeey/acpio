import { formatBytes } from "./lib/bytes.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [52428800, "50.0 MB"],
  [3221225472, "3.0 GB"],
  [1099511627776, "1.0 TB"],
];
for (const [input, expected] of cases) {
  const got = formatBytes(input);
  if (got !== expected) fail("formatBytes(" + input + ") -> " + got + ", expected " + expected);
}
for (const bad of [-1, NaN, Infinity, "100"]) {
  let threw = false;
  try { formatBytes(bad); } catch { threw = true; }
  if (!threw) fail("formatBytes(" + String(bad) + ") must throw");
}

console.log("PASS: byte sizes use binary units");
