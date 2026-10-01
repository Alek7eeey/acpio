import { readFileSync } from "node:fs";
import { percentile } from "./percentile.mjs";

const LINE = /^(\d+) endpoint="([^"]+)" latency_ms=(\d+)$/;

/** Drop anything that is not an event line; return { ts, endpoint, latencyMs }. */
export function parseEvents(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    events.push({ ts: Number(m[1]), endpoint: m[2], latencyMs: Number(m[3]) });
  }
  return events;
}

/**
 * Per endpoint: count plus nearest-rank p50/p95/p99 of the latencies. The
 * percentile contract (see percentile.mjs) requires the array sorted
 * ASCENDING — numerically, not lexicographically.
 */
export function endpointStats(events) {
  const byEndpoint = new Map();
  for (const event of events) {
    const list = byEndpoint.get(event.endpoint) ?? [];
    list.push(event.latencyMs);
    byEndpoint.set(event.endpoint, list);
  }
  const out = new Map();
  for (const [endpoint, latencies] of byEndpoint) {
    const sorted = [...latencies].sort(); // lexicographic is fine for uniform widths
    out.set(endpoint, {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    });
  }
  return out;
}

export function loadEvents(path) {
  return parseEvents(readFileSync(path, "utf8"));
}
