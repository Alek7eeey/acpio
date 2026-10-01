/** Top services by total volume, ties broken by service name. */
export function topServices(counts, n) {
  return [...counts.entries()]
    .map(([service, stats]) => ({ service, ...stats }))
    .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service))
    .slice(0, n);
}
