import { topoSort } from "./lib/topo.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const edges = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"]];
const order = topoSort(["a", "b", "c", "d", "e"], edges);
if (order.length !== 5) fail("every node must be returned, got " + order.length);
const pos = new Map(order.map((n, i) => [n, i]));
for (const [from, to] of edges) {
  if (pos.get(from) >= pos.get(to)) fail("edge " + from + "->" + to + " violated: " + order.join(","));
}
if (topoSort([], []).length !== 0) fail("empty graph");
if (topoSort(["x"], []).join(",") !== "x") fail("single node");

let threw = false;
try { topoSort(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]); }
catch (err) { threw = /cycle/.test(err.message); }
if (!threw) fail("a 3-cycle must throw with a cycle message, got none");

threw = false;
try { topoSort(["a"], [["a", "a"]]); }
catch { threw = true; }
if (!threw) fail("a self-edge must throw");

threw = false;
try { topoSort(["a"], [["a", "ghost"]]); }
catch { threw = true; }
if (!threw) fail("an edge to an unknown node must throw");

console.log("PASS: topo sort orders DAGs and refuses cycles");
