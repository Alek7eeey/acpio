import { merge3 } from "./lib/merge3.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const base = ["prices", "vat", "totals"];
const ours = ["prices", "vat 19", "totals"];
const theirs = ["prices", "vat 20", "totals"];
const merged = merge3(base, ours, theirs);
if (!merged.conflict) fail("two different edits of the vat line must conflict, got: " + JSON.stringify(merged.merged));
if (!merged.merged.includes("vat 19") || !merged.merged.includes("vat 20")) fail("a conflict must carry BOTH sides, got: " + merged.merged.join(" | "));

console.log("PASS: conflicting edits surface as conflicts, nothing is dropped");
