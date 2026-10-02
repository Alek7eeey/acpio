import { cleanParams } from "./lib/params.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const input = { page: 0, enabled: false, q: "", label: null, extra: undefined, name: "x", size: 5 };
const cleaned = cleanParams(input);
if (!eq(cleaned, { page: 0, enabled: false, name: "x", size: 5 })) {
  fail("0 and false must survive, empty/null/undefined must go: " + JSON.stringify(cleaned));
}
if (!eq(input, { page: 0, enabled: false, q: "", label: null, extra: undefined, name: "x", size: 5 })) fail("input was mutated");
if (!eq(cleanParams({}), {})) fail("empty input");
if (!eq(cleanParams({ a: null, b: "" }), {})) fail("all-dropped input");
if (!eq(cleanParams({ n: 0 }), { n: 0 })) fail("lone zero must survive");
if (!eq(cleanParams({ ok: false }), { ok: false })) fail("lone false must survive");

console.log("PASS: only null/undefined/empty-string are dropped");
