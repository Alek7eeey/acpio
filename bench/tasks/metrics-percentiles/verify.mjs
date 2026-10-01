import { percentile } from "./lib/percentile.mjs";
import { parseEvents, endpointStats, loadEvents } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
if (percentile(hundred, 50) !== 50 || percentile(hundred, 95) !== 95 || percentile(hundred, 99) !== 99) fail("nearest-rank anchors broken");
if (percentile([7], 95) !== 7) fail("single value");
if (percentile([1, 2, 3], 50) !== 2 || percentile([1, 2, 3], 95) !== 3) fail("tiny arrays");
let threw = false;
try { percentile([], 50); } catch { threw = true; }
if (!threw) fail("empty input must throw");

const events = loadEvents("data/events.log");
if (events.length !== 4000) fail("expected 4000 events, got " + events.length);
if (events[0].endpoint !== "GET /api/users" || events[0].latencyMs !== 120) fail("first event wrong: " + JSON.stringify(events[0]));
if (parseEvents("not a line\n").length !== 0) fail("garbage must be dropped");

const stats = endpointStats(events);
const byEndpoint = new Map();
for (const e of events) {
  const list = byEndpoint.get(e.endpoint) ?? [];
  list.push(e.latencyMs);
  byEndpoint.set(e.endpoint, list);
}
const rank = (sorted, p) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
for (const [endpoint, latencies] of byEndpoint) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const expected = { count: sorted.length, p50: rank(sorted, 50), p95: rank(sorted, 95), p99: rank(sorted, 99) };
  const got = stats.get(endpoint);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    fail(endpoint + ": got " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
  }
}
if (stats.get("GET /api/users").count !== 800) fail("each endpoint must have 800 samples");
if (stats.size !== 5) fail("expected 5 endpoints, got " + stats.size);

console.log("PASS: percentiles are nearest-rank over ascending sort");
