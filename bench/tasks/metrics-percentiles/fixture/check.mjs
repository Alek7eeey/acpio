import { loadEvents, endpointStats } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const events = loadEvents("data/events.log");
if (events.length !== 4000) fail("expected 4000 events, got " + events.length);
const stats = endpointStats(events);
const users = stats.get("GET /api/users");
if (!users || users.count !== 800) fail("GET /api/users must have 800 samples, got " + JSON.stringify(users));
if (users.p95 <= users.p50) fail("p95 must exceed p50 for a wide distribution: " + JSON.stringify(users));

console.log("PASS: per-endpoint stats look sane");
