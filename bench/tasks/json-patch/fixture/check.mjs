import { applyPatch } from "./lib/patch.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const board = applyPatch({ cards: ["one", "two", "three"] }, [{ op: "move", from: "cards.0", path: "cards.2" }]);
if (board.cards.join(",") !== "two,one,three") {
  fail("dragging card one onto slot three lost a card: " + board.cards.join(","));
}

console.log("PASS: a forward move lands on the requested slot");
