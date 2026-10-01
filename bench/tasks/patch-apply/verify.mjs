import { applyPatch } from "./lib/apply.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const source = ["one", "two", "three", "four", "five"];
// Both hunks in ONE patch: the second must follow the +2 lines the first added.
const combined = "@@ -2,1 +2,3 @@\n two\n+two and a half\n+two and three quarters\n@@ -4,2 +6,2 @@\n four\n-five\n+FIVE!\n";
const out = applyPatch(source, combined);
if (out.join("|") !== "one|two|two and a half|two and three quarters|three|four|FIVE!") {
  fail("hunk after an inserting hunk landed wrong: " + out.join("|"));
}

// A deleting hunk shifts the next one back by one.
const shrink = "@@ -1,2 +1,1 @@\n one\n-two\n@@ -4,2 +3,2 @@\n four\n-five\n+4.5\n";
const shrunk = applyPatch(source, shrink);
if (shrunk.join("|") !== "one|three|four|4.5") {
  fail("hunk after a deleting hunk landed wrong: " + shrunk.join("|"));
}

const src = ["a", "b", "c"];
const frozen = applyPatch(src, "@@ -1,1 +1,1 @@\n-a\n+A!\n");
if (src.join("|") !== "a|b|c") fail("input array was mutated");
if (frozen.join("|") !== "A!|b|c") fail("single-hunk replace broken: " + frozen.join("|"));

if (applyPatch(src, "").join("|") !== "a|b|c") fail("empty patch must be a no-op");

let threw = false;
try { applyPatch(src, "@@ -2,1 +2,1 @@\n NOT-TWO\n"); } catch { threw = true; }
if (!threw) fail("mismatched context must throw");

console.log("PASS: offsets accumulate across hunks, matching stays exact");
