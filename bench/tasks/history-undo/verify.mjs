import { createHistory } from "./lib/history.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const h = createHistory("v0");
h.commit("v1");
h.commit("v2");
if (h.get() !== "v2" || !h.canUndo() || h.canRedo()) fail("baseline broken");
if (h.undo() !== "v1") fail("undo broken");
h.commit("v3");
if (h.canRedo()) fail("commit must clear the redo branch");
if (h.redo() !== "v3") fail("redo after an edit must be a no-op, got " + h.redo());
if (h.get() !== "v3") fail("redo after an edit must keep the edited present");

if (h.undo() !== "v1") fail("undo chain broken");
if (h.redo() !== "v3") fail("redo chain broken");
if (h.undo() !== "v1" || h.undo() !== "v0") fail("undo to bottom broken");
if (h.undo() !== "v0" || !h.canRedo()) fail("undo at the bottom must be a no-op");
if (h.redo() !== "v1") fail("redo after bottom no-op broken");

console.log("PASS: commit clears redo, undo/redo walk the chain");
