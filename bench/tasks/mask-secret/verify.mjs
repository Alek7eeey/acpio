import { maskSecret } from "./lib/mask.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (maskSecret("sk-live-12345678") !== "************5678") fail("long token broken: " + maskSecret("sk-live-12345678"));
if (maskSecret("abcde") !== "*bcde") fail("5-char secret broken: " + maskSecret("abcde"));
if (maskSecret("abcd") !== "****") fail("4-char secret must be masked completely");
if (maskSecret("abc") !== "***") fail("3-char secret");
if (maskSecret("a") !== "*") fail("1-char secret");
if (maskSecret("") !== "") fail("empty string");
for (const bad of [5, null, undefined, { length: 8 }]) {
  let threw = false;
  try { maskSecret(bad); } catch { threw = true; }
  if (!threw) fail("maskSecret(" + String(bad) + ") must throw");
}

console.log("PASS: only the last four characters stay visible");
