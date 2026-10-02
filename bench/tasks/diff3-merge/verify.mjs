import { merge3 } from "./lib/merge3.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(merge3(["a", "b"], ["a", "b"], ["a", "b"]).merged, ["a", "b"])) fail("no-change merge broken");
if (merge3(["a", "b"], ["a", "b"], ["a", "b"]).conflict !== false) fail("no-change merge must not conflict");

const onlyOurs = merge3(["x"], ["x", "y"], ["x"]);
if (!eq(onlyOurs.merged, ["x", "y"]) || onlyOurs.conflict) fail("only-ours append broken: " + JSON.stringify(onlyOurs));
const onlyTheirs = merge3(["x"], ["x"], ["z", "x"]);
if (!eq(onlyTheirs.merged, ["z", "x"]) || onlyTheirs.conflict) fail("only-theirs prepend broken: " + JSON.stringify(onlyTheirs));
const onlyTheirsEdit = merge3(["a", "b", "c"], ["a", "b", "c"], ["a", "B", "c"]);
if (!eq(onlyTheirsEdit.merged, ["a", "B", "c"]) || onlyTheirsEdit.conflict) fail("only-theirs edit broken");

const sameEdit = merge3([1, 2, 3], [1, 9, 3], [1, 9, 3]);
if (!eq(sameEdit.merged, [1, 9, 3]) || sameEdit.conflict) fail("identical edits must not conflict: " + JSON.stringify(sameEdit));
const sameDelete = merge3(["a", "b", "c"], ["a"], ["a"]);
if (!eq(sameDelete.merged, ["a"]) || sameDelete.conflict) fail("identical deletions must not conflict: " + JSON.stringify(sameDelete));

const conflict = merge3(["a", "b", "c"], ["a", "X", "c"], ["a", "Y", "c"]);
if (conflict.conflict !== true) fail("two different edits of one line must conflict");
if (!conflict.merged.includes("X") || !conflict.merged.includes("Y")) fail("the conflict must carry both sides: " + JSON.stringify(conflict.merged));
if (!conflict.merged.includes("=======")) fail("the conflict must carry the marker block");
if (!eq(conflict.merged[0], "a") || !eq(conflict.merged[conflict.merged.length - 1], "c")) fail("conflict must sit between the common head and tail");

const tailConflict = merge3(["a"], ["a", "x"], ["a", "y"]);
if (tailConflict.conflict !== true) fail("both appending different lines must conflict");
if (!tailConflict.merged.includes("x") || !tailConflict.merged.includes("y")) fail("appended conflict lost a side");

const base2 = ["a", "b", "c", "d"];
const ours2 = ["A", "b", "c", "d"];
const theirs2 = ["a", "b", "c", "D"];
merge3(base2, ours2, theirs2);
if (!eq(base2, ["a", "b", "c", "d"]) || !eq(ours2, ["A", "b", "c", "d"]) || !eq(theirs2, ["a", "b", "c", "D"])) fail("inputs were mutated");

console.log("PASS: same-region conflicts surface with both sides intact");
