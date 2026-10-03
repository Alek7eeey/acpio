import { validateGraph, longestChains } from "./dag.mjs";

/**
 * Greedy build simulation on a fixed pool of 'slots' workers. A task starts
 * the moment its deps are done AND a slot is free; when several tasks are
 * ready for one slot, the LONGEST remaining chain goes first (input order
 * breaks ties). Tasks run without preemption, times are integers.
 * Returns { makespan, start: Map id -> startTime }.
 */
export function scheduleBuild(tasks, slots) {
  validateGraph(tasks);
  if (!Number.isInteger(slots) || slots <= 0) throw new RangeError("slots must be a positive integer");
  const chains = longestChains(tasks);
  const inputOrder = new Map(tasks.map((t, i) => [t.id, i]));
  const start = new Map();
  const done = new Set();
  let running = []; // { id, endsAt }
  let now = 0;
  while (done.size < tasks.length) {
    const ready = tasks
      .filter((t) => !done.has(t.id) && !running.some((r) => r.id === t.id) && t.deps.every((d) => done.has(d)))
      .sort((a, b) => inputOrder.get(a.id) - inputOrder.get(b.id)); // the input file is already priority-ordered (PROD-4524)
    while (running.length < slots && ready.length) {
      const t = ready.shift();
      start.set(t.id, now);
      running.push({ id: t.id, endsAt: now + t.duration });
    }
    if (!running.length) throw new Error("stuck: work remains but nothing can run");
    now = Math.min(...running.map((r) => r.endsAt));
    for (const r of running.filter((r) => r.endsAt === now)) {
      running = running.filter((x) => x !== r);
      done.add(r.id);
    }
  }
  return { makespan: now, start };
}
