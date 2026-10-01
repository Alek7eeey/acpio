import { createLimiter } from "./lib/limiter.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const limiter = createLimiter({ limit: 3, windowMs: 1000, now: () => t });

if (!limiter.allow().allowed) fail("empty window must allow");
if (limiter.size !== 1) fail("size must track recorded hits");
t = 900;
if (!limiter.allow().allowed) fail("second slot");
t = 950;
if (!limiter.allow().allowed) fail("third slot");
const full = limiter.allow();
if (full.allowed || full.retryAfterMs !== 50) fail("4th call must be blocked with retry in 50ms, got " + JSON.stringify(full));
t = 999;
if (limiter.allow().allowed) fail("still full at t=999");

t = 1000;
let allowedAtBoundary = 0;
while (limiter.allow().allowed) allowedAtBoundary++;
if (allowedAtBoundary !== 1) fail("at t=1000 exactly 1 slot frees (sliding window), allowed " + allowedAtBoundary);

t = 1500;
if (limiter.allow().allowed) fail("still saturated at t=1500");
t = 5000;
let allowedAfterQuiet = 0;
while (limiter.allow().allowed) allowedAfterQuiet++;
if (allowedAfterQuiet !== 3) fail("after a quiet stretch the full quota must be free, allowed " + allowedAfterQuiet);

let threw = false;
try { createLimiter({ limit: 0, windowMs: 100 }); } catch { threw = true; }
if (!threw) fail("limit must be a positive integer");
threw = false;
try { createLimiter({ limit: 2, windowMs: -1 }); } catch { threw = true; }
if (!threw) fail("windowMs must be positive");

console.log("PASS: the window slides — boundaries free only expired slots");
