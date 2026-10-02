import { applyPatch } from "./lib/patch.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const doc = { user: { name: "Ada", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d"], keep: true };

if (!eq(applyPatch(doc, [{ op: "add", path: "user.email", value: "a@b.c" }]).user.email, "a@b.c")) fail("add object key");
if (!eq(applyPatch(doc, [{ op: "add", path: "list.0", value: "z" }]).list, ["z", "a", "b", "c", "d"])) fail("add must INSERT into arrays");
if (!eq(applyPatch(doc, [{ op: "add", path: "list.-", value: "end" }]).list, ["a", "b", "c", "d", "end"])) fail("add '-' must append");
if (!eq(applyPatch(doc, [{ op: "remove", path: "user.name" }]).user, { tags: ["x", "y", "z"] })) fail("remove object key");
if (!eq(applyPatch(doc, [{ op: "remove", path: "list.1" }]).list, ["a", "c", "d"])) fail("remove must splice arrays");
if (!eq(applyPatch(doc, [{ op: "replace", path: "list.2", value: "C" }]).list, ["a", "b", "C", "d"])) fail("replace array element");
if (!eq(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.2" }]).list, ["b", "a", "c", "d"])) {
  fail("a forward move must land at the index the original array named: " + JSON.stringify(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.2" }]).list));
}
if (!eq(applyPatch(doc, [{ op: "move", from: "list.3", path: "list.0" }]).list, ["d", "a", "b", "c"])) fail("move backward broken");
if (!eq(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.-" }]).list, ["b", "c", "d", "a"])) fail("move to '-' must append");
if (!eq(applyPatch(doc, [{ op: "move", from: "user.tags.2", path: "user.tags.0" }]).user.tags, ["z", "x", "y"])) fail("nested move broken");
if (!eq(applyPatch({ a: 1, b: 2 }, [{ op: "move", from: "a", path: "c" }]), { b: 2, c: 1 })) fail("object move broken");
const cross = applyPatch({ src: [1, 2], dst: [] }, [{ op: "move", from: "src.0", path: "dst.-" }]);
if (!eq(cross.src, [2]) || !eq(cross.dst, [1])) fail("cross-container move broken");
if (!eq(applyPatch(doc, [
  { op: "replace", path: "user.name", value: "A." },
  { op: "add", path: "list.-", value: "e" },
]), { user: { name: "A.", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d", "e"], keep: true })) fail("multi-op sequence broken");

if (!eq(doc, { user: { name: "Ada", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d"], keep: true })) fail("input doc was mutated");

let threw = false;
try { applyPatch(doc, [{ op: "nope", path: "list.0" }]); } catch { threw = true; }
if (!threw) fail("unknown op must throw");
threw = false;
try { applyPatch(doc, [{ op: "replace", path: "ghost.path", value: 1 }]); } catch { threw = true; }
if (!threw) fail("replace on a missing path must throw");
threw = false;
try { applyPatch(doc, [{ op: "remove", path: "list.9" }]); } catch { threw = true; }
if (!threw) fail("remove past the end must throw");
threw = false;
try { applyPatch(doc, [{ op: "move", from: "list.0", path: "list.9" }]); } catch { threw = true; }
if (!threw) fail("move past the end must throw");

console.log("PASS: add/remove/replace/move behave, moves keep pre-move indexes");
