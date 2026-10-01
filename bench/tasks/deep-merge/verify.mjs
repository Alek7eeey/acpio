import { deepMerge } from "./lib/merge.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
const patch = { nested: { y: 3, z: 4 }, list: [9], b: 2 };
const baseCopy = JSON.parse(JSON.stringify(base));
const patchCopy = JSON.parse(JSON.stringify(patch));

const merged = deepMerge(base, patch);
if (merged.nested.y !== 3 || merged.nested.z !== 4 || merged.nested.x !== 1) fail("nested merge wrong: " + JSON.stringify(merged.nested));
if (merged.a !== 1 || merged.b !== 2) fail("scalar keys wrong");
if (JSON.stringify(merged.list) !== "[9]") fail("patch array must replace: " + JSON.stringify(merged.list));
if (JSON.stringify(base) !== JSON.stringify(baseCopy)) fail("base was mutated: " + JSON.stringify(base));
if (JSON.stringify(patch) !== JSON.stringify(patchCopy)) fail("patch was mutated");

const merged2 = deepMerge({ k: { v: 1 } }, { k: null });
if (merged2.k !== null) fail("null patch must clear the key");

console.log("PASS: deepMerge is non-mutating, arrays replace, null clears");
