/**
 * Kahn topological sort. `edges` are [before, after] pairs over `nodes`.
 * Returns every node exactly once, each edge respecting order. A cycle is a
 * hard error — Error("cycle among: ...") — a partial order must never be
 * returned silently.
 */
export function topoSort(nodes, edges = []) {
  const nodeSet = new Set(nodes);
  const indegree = new Map([...nodeSet].map((n) => [n, 0]));
  const next = new Map([...nodeSet].map((n) => [n, []]));
  for (const [from, to] of edges) {
    if (!nodeSet.has(from) || !nodeSet.has(to)) throw new Error("unknown node in edge: " + from + " -> " + to);
    next.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  const settled = new Set();
  const out = [];
  while (ready.length > 0) {
    const n = ready.shift();
    out.push(n);
    settled.add(n);
    for (const m of next.get(n)) {
      indegree.set(m, indegree.get(m) - 1);
      if (indegree.get(m) === 0) ready.push(m);
    }
  }
  if (out.length !== nodeSet.size) {
    // Anything that never reached indegree 0 is stuck on a cycle (or on a node
    // that is). Handing back only `out` would silently truncate the plan, so
    // the caller has to hear about it — name the stuck nodes.
    const stuck = [...nodeSet].filter((n) => !settled.has(n));
    throw new Error("cycle among: " + stuck.join(", "));
  }
  return out;
}
