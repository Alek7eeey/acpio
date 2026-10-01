import { stableStringify } from "./lib/stable.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const a = { user: "ada", prefs: { theme: "dark", lang: "en", flags: { beta: true } }, tags: ["x", "y"] };
const b = { tags: ["x", "y"], prefs: { flags: { beta: true }, lang: "en", theme: "dark" }, user: "ada" };
if (stableStringify(a) !== stableStringify(b)) fail("deep-equal objects with different key order must stringify identically");
if (stableStringify({ b: 1, a: 2 }) !== '{"a":2,"b":1}') fail("top-level keys must be sorted");
if (stableStringify([{ b: 1, a: 2 }]) !== '[{"a":2,"b":1}]') fail("keys inside arrays must be sorted too");
if (stableStringify([3, 1, 2]) !== "[3,1,2]") fail("array order must be preserved");
if (stableStringify("x") !== '"x"' || stableStringify(5) !== "5" || stableStringify(null) !== "null" || stableStringify(true) !== "true") fail("scalars broken");
if (stableStringify({}) !== "{}" || stableStringify([]) !== "[]") fail("empty containers broken");

console.log("PASS: stringify is stable under key order at every depth");
