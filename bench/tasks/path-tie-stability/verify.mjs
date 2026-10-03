import { shortestPath } from "./lib/paths.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const g = {
  A: [{ to: "B1", w: 1 }, { to: "C", w: 5 }],
  B1: [{ to: "B2", w: 1 }],
  B2: [{ to: "D", w: 8 }],
  C: [{ to: "D", w: 5 }],
  D: [],
};
const p = shortestPath(g, "A", "D");
if (!eq(p, ["A", "C", "D"])) fail("equal cost 10 must pick the 2-leg route: " + JSON.stringify(p));

const direct = {
  A: [{ to: "D", w: 10 }, { to: "B", w: 1 }],
  B: [{ to: "D", w: 9 }],
  D: [],
};
if (!eq(shortestPath(direct, "A", "D"), ["A", "D"])) fail("the fewer-hop path found first stays put");

const isolated = { A: [{ to: "B", w: 1 }], B: [], C: [] };
if (shortestPath(isolated, "A", "C") !== null) fail("no path is null");
if (!eq(shortestPath(g, "A", "A"), ["A"])) fail("from === to");
if (!eq(shortestPath({ A: [{ to: "B", w: 0 }], B: [{ to: "C", w: 0 }], C: [] }, "A", "C"), ["A", "B", "C"])) {
  fail("zero weights chain");
}
throws(() => shortestPath(g, "Q", "A"), "unknown start node");

console.log("PASS: at equal cost the fewest-hop route wins");
