import { topoSort } from "./fixture/lib/topo.mjs";

let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fails.push(name + ": " + err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function caughtError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}
function validOrder(nodes, edges, order) {
  if (order.length !== nodes.length) return false;
  if (new Set(order).size !== order.length) return false;
  for (const n of nodes) if (!order.includes(n)) return false;
  const pos = new Map(order.map((n, i) => [n, i]));
  for (const [f, t] of edges) if (pos.get(f) >= pos.get(t)) return false;
  return true;
}

// 1. plain valid DAG
check("valid DAG", () => {
  const nodes = ["a", "b", "c", "d", "e"];
  const edges = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"]];
  const order = topoSort(nodes, edges);
  assert(validOrder(nodes, edges, order), "not a valid topo order: " + order.join(","));
});

// 2. diamond
check("diamond", () => {
  const nodes = ["top", "l", "r", "bottom"];
  const edges = [["top", "l"], ["top", "r"], ["l", "bottom"], ["r", "bottom"]];
  const order = topoSort(nodes, edges);
  assert(validOrder(nodes, edges, order), "not a valid topo order: " + order.join(","));
  assert(order[0] === "top", "top must be first");
  assert(order[3] === "bottom", "bottom must be last");
});

// 3. empty graph
check("empty graph", () => {
  assert(Array.isArray(topoSort([])), "must return an array");
  assert(topoSort([]).length === 0, "must be empty");
  assert(topoSort().length === 0, "must be empty with no args");
});

// 3b. no edges at all
check("no edges", () => {
  assert(topoSort(["x", "y", "z"]).length === 3, "all nodes returned");
});

// 3c. several disconnected components
check("disconnected components", () => {
  const nodes = ["a", "b", "c", "d"];
  const edges = [["a", "b"], ["c", "d"]];
  assert(validOrder(nodes, edges, topoSort(nodes, edges)));
});

// 3d. duplicate entries in `nodes`
check("duplicate nodes", () => {
  const order = topoSort(["a", "a", "b"], [["a", "b"]]);
  assert(order.length === 2, "each node returned exactly once, got " + order.length);
  assert(order.join(",") === "a,b", "got " + order.join(","));
});

// 3e. parallel edges
check("parallel edges", () => {
  const nodes = ["a", "b"];
  assert(validOrder(nodes, [["a", "b"], ["a", "b"]], topoSort(nodes, [["a", "b"], ["a", "b"]])));
});

// 4. 3-cycle
check("3-cycle throws", () => {
  const nodes = ["a", "b", "c"];
  const err = caughtError(() => topoSort(nodes, [["a", "b"], ["b", "c"], ["c", "a"]]));
  assert(err instanceof Error, "must throw an Error, not return");
  assert(/cycle/.test(err.message), "message must mention a cycle, got: " + err.message);
  for (const n of nodes) {
    assert(err.message.includes(n), "stuck node " + n + " missing from message: " + err.message);
  }
  assert(err.message.includes("a"), "message must name the cycle");
});

// 4b. 2-cycle (mutual dependency)
check("2-cycle throws", () => {
  const err = caughtError(() => topoSort(["p", "q"], [["p", "q"], ["q", "p"]]));
  assert(err instanceof Error, "must throw an Error");
  assert(/cycle/.test(err.message), "message must mention a cycle, got: " + err.message);
  assert(err.message.includes("p") && err.message.includes("q"), "both stuck nodes named");
});

// 4c. a cycle must never leak a partial order
check("no partial order leaks", () => {
  const nodes = ["a", "b", "c", "d"];
  const edges = [["a", "b"], ["b", "c"], ["c", "b"], ["b", "d"]];
  const result = caughtError(() => topoSort(nodes, edges));
  assert(result instanceof Error, "must throw instead of returning a partial order");
  assert(/cycle/.test(result.message), "message must mention a cycle, got: " + result.message);
  // a, d are not part of the cycle; b, c are
  assert(result.message.includes("b") && result.message.includes("c"), "b and c are stuck");
});

// 5. self-edge
check("self-edge throws", () => {
  const err = caughtError(() => topoSort(["a"], [["a", "a"]]));
  assert(err instanceof Error, "must throw an Error");
  assert(err.message.includes("a"), "self-loop node must be named: " + err.message);
});

// 5b. self-edge among other nodes
check("self-edge among other nodes", () => {
  const err = caughtError(() => topoSort(["a", "b", "c"], [["a", "b"], ["b", "b"], ["b", "c"]]));
  assert(err instanceof Error, "must throw an Error");
  assert(err.message.includes("b"), "b must be named: " + err.message);
});

// 6. unknown nodes
check("unknown node throws", () => {
  for (const [f, t] of [["ghost", "a"], ["a", "ghost"], ["ghost", "ghost"]]) {
    const err = caughtError(() => topoSort(["a"], [[f, t]]));
    assert(err instanceof Error, "unknown node edge " + f + "->" + t + " must throw");
    assert(/unknown node/.test(err.message), "message must say unknown node, got: " + err.message);
    assert(err.message.includes(f) || err.message.includes(t), "must name the bad edge");
  }
});

// 7. `nodes` argument shape is respected (no auto-discovery from edges)
check("edges cannot introduce nodes", () => {
  const err = caughtError(() => topoSort(["a", "b"], [["b", "c"]]));
  assert(err instanceof Error, "edges over unknown nodes must throw");
});

// 8. determinism: same inputs -> same output
check("deterministic", () => {
  const nodes = ["a", "b", "c", "d", "e", "f"];
  const edges = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"], ["d", "f"]];
  const first = topoSort(nodes, edges).join(",");
  for (let i = 0; i < 20; i++) {
    assert(topoSort(nodes, edges).join(",") === first, "order must be stable across calls");
  }
});

// 9. cycle error is a plain Error (not a string throw)
check("throws real Errors", () => {
  for (const [nodes, edges] of [
    [["a", "b"], [["a", "b"], ["b", "a"]]],
    [["a"], [["a", "a"]]],
  ]) {
    const err = caughtError(() => topoSort(nodes, edges));
    assert(err instanceof Error, "must be an Error instance, got " + typeof err);
    assert(typeof err.message === "string" && err.message.length > 0, "must have a message");
  }
});

// 10. larger random stress: valid DAG always orders, cyclic always throws
check("stress", () => {
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(Math.random() * 12);
    const nodes = Array.from({ length: n }, (_, i) => "n" + i);
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.random() < 0.35) edges.push(["n" + i, "n" + j]);
      }
    }
    if (Math.random() < 0.5 && edges.length > 0) {
      // inject a back edge to force a cycle
      edges.push([nodes[Math.floor(Math.random() * n)], nodes[Math.floor(Math.random() * n)]]);
      const err = caughtError(() => topoSort(nodes, edges));
      if (err === null && edges.some(([f, t]) => f === t)) throw new Error("self loop not caught");
      if (err === null && hasCycle(nodes, edges)) throw new Error("cycle not caught");
    } else {
      const order = topoSort(nodes, edges);
      if (!validOrder(nodes, edges, order)) throw new Error("bad order " + order.join(","));
    }
  }
});

function hasCycle(nodes, edges) {
  const adj = new Map(nodes.map((x) => [x, []]));
  for (const [f, t] of edges) adj.get(f).push(t);
  const state = new Map(nodes.map((x) => [x, 0]));
  const visit = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u)) {
      if (state.get(v) === 1) return true;
      if (state.get(v) === 0 && visit(v)) return true;
    }
    state.set(u, 2);
    return false;
  };
  return nodes.some((u) => state.get(u) === 0 && visit(u));
}

if (fails.length > 0) {
  console.error("FAILED " + fails.length + " check(s):");
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log("PASS: " + pass + " checks (valid DAG, diamond, empty graph, 3-cycle, self-edge, unknown node)");
