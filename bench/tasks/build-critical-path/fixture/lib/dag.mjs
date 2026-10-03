/**
 * Build task graph: id -> { id, duration, deps }. Durations are positive
 * integers; deps reference existing ids; the graph must be acyclic.
 */
export function validateGraph(tasks) {
  for (const t of tasks) {
    if (!Number.isInteger(t.duration) || t.duration <= 0) {
      throw new RangeError("duration must be a positive integer: " + t.id);
    }
    for (const dep of t.deps) {
      if (!tasks.some((x) => x.id === dep)) throw new Error("unknown dep " + dep + " on " + t.id);
    }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const visit = (id) => {
    const s = state.get(id);
    if (s === 1) throw new Error("cycle at " + id);
    if (s === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id).deps) visit(dep);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
}

/** Longest chain ENDING at each task, itself included — the critical-path
 * priority: a task that drags the tail must start as soon as a slot opens. */
export function longestChains(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const chain = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = byId.get(id);
    const best = t.deps.length ? Math.max(...t.deps.map(chain)) : 0;
    memo.set(id, best + t.duration);
    return memo.get(id);
  };
  for (const t of tasks) chain(t.id);
  return memo;
}
