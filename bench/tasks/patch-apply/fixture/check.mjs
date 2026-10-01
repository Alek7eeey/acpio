import { readFileSync } from "node:fs";
import { applyPatch } from "./lib/apply.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const read = (p) => readFileSync(p, "utf8").split("\n");

const source = read("samples/app.txt");
const afterFeature = applyPatch(source, read("patches/feature.patch").join("\n"));
if (afterFeature[2] !== 'import { validate } from "./validate.mjs"') fail("hunk 1 lost: " + afterFeature[2]);
if (afterFeature[8] !== "  for (const user of cache.warm(users)) {") fail("hunk 2 landed wrong: " + afterFeature[8]);
if (afterFeature.length !== 15) fail("line count wrong: " + afterFeature.length);

const afterFixup = applyPatch(afterFeature, read("patches/fixup.patch").join("\n"));
if (afterFixup[6] !== "async function main() {") fail("fixup hunk lost: " + JSON.stringify(afterFixup[6]));
if (afterFixup.length !== 15) fail("fixup must not change the line count");

let threw = false;
try {
  applyPatch(source, "@@ -100,1 +100,1 @@\n-no such line\n");
} catch {
  threw = true;
}
if (!threw) fail("a patch whose context is absent must throw");

console.log("PASS: multi-hunk patches track offsets, bad context still throws");
