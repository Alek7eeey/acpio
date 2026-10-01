/** Per-service totals: line count, error count, and the max weight seen. */
export function byService(events) {
  const out = new Map();
  for (const event of events) {
    const stats = out.get(event.service) ?? { total: 0, errors: 0, maxWeight: 0 };
    stats.total += 1;
    if (event.level === "error") stats.errors += 1;
    stats.maxWeight = Math.max(stats.maxWeight, event.weight);
    out.set(event.service, stats);
  }
  return out;
}
