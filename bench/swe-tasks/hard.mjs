// swe-* tasks, hard band: multi-module pipelines, generated data, symptoms
// far from the cause, cross-cutting policies (ordering, netting, atomicity,
// freezing). Same generator rule: verifier fails on the planted bug,
// passes on the fixed sources.
import { def } from "./support.mjs";

/** Deterministic event log: 4000 real lines over 5 endpoints + 40-ish garbage lines. */
function buildEventsLog() {
  const endpoints = ["GET /api/users", "GET /api/items", "POST /api/orders", "GET /api/health", "POST /api/search"];
  const bases = [120, 45, 300, 5, 210];
  const lines = [];
  for (let i = 0; i < 4000; i++) {
    const slot = i % 5;
    const latency = bases[slot] + ((i * 53) % 1000);
    lines.push((1_700_000_000_000 + i * 7) + ' endpoint="' + endpoints[slot] + '" latency_ms=' + latency);
  }
  lines.push("", "# rotated file header", "garbage line without fields", '12345 endpoint="x" latency_ms=oops', '12 endpoint="GET /api/users"');
  return lines.join("\n") + "\n";
}

/** Deterministic sales log: 2400 orders over 2026-01..2026-06 across 4
 * regions, plus 240 refunds dated in July referencing earlier orders. */
function buildOrdersJsonl() {
  const regions = ["eu", "us", "apac", "latam"];
  const lines = [];
  for (let i = 0; i < 2400; i++) {
    const month = 1 + (i % 6);
    lines.push(JSON.stringify({
      type: "order",
      id: "o" + (1000 + i),
      date: "2026-0" + month + "-" + String(1 + (i % 28)).padStart(2, "0"),
      region: regions[Math.floor(i / 6) % 4],
      amount: 1000 + ((i * 37) % 9000),
    }));
  }
  for (let r = 0; r < 240; r++) {
    lines.push(JSON.stringify({
      type: "refund",
      id: "r" + r,
      refund_of: "o" + (1000 + ((r * 7 + 3) % 2400)),
      date: "2026-07-" + String(1 + (r % 20)).padStart(2, "0"),
      amount: -(500 + ((r * 13) % 4000)),
    }));
  }
  return lines.join("\n") + "\n";
}

export default [
  def(
    "hard",
    "semver-resolver",
    "Resolver installs a beta for a caret range",
    "Run `node check.mjs`. CI resolved ^1.2.0 to 1.9.0-beta.2 and shipped a prerelease to staging. The registry keeps betas around, so the rule is the one documented in lib/semver.mjs: a prerelease binds LOWER than the version it belongs to (1.0.0-rc.1 < 1.0.0), and ranges resolve to the highest RELEASE unless the range itself names a prerelease. The symptom shows in lib/resolve.mjs, but the corruption is in the comparator it sorts with. Fix the cause, keep every interface, and verify with your own script (comparator directions, ^/~/>=/<=/exact/*, prerelease gating, unsatisfied range throws) before answering.",
    {
      "lib/semver.mjs": `/**
 * Semver 2.0 subset for our internal registry: MAJOR.MINOR.PATCH with an
 * optional -PRERELEASE tag. Comparing follows the spec on the one point
 * that matters for releases: a prerelease binds LOWER than the version it
 * belongs to (1.0.0-rc.1 < 1.0.0). Prerelease tags compare
 * lexicographically — enough for our alpha/beta/rc tags.
 */
export function parseVersion(version) {
  const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) throw new Error("bad version: " + version);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (A[key] !== B[key]) return A[key] - B[key];
  }
  if (A.prerelease === B.prerelease) return 0;
  if (A.prerelease === null) return 1;
  if (B.prerelease === null) return -1;
  return String(A.prerelease).localeCompare(String(B.prerelease));
}

/**
 * Ranges: "*" (releases only), "X.Y.Z" (exact), "^X.Y.Z" (same major, at
 * least X.Y.Z), "~X.Y.Z" (same major.minor, at least X.Y.Z), ">=X.Y.Z" and
 * "<=X.Y.Z". A prerelease satisfies a range only when the range itself
 * names a prerelease.
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (range === "*") return v.prerelease === null;
  if (v.prerelease !== null && !range.includes("-")) return false;
  if (range.startsWith("^")) {
    const base = range.slice(1);
    return v.major === parseVersion(base).major && compareVersions(version, base) >= 0;
  }
  if (range.startsWith("~")) {
    const base = range.slice(1);
    const b = parseVersion(base);
    return v.major === b.major && v.minor === b.minor && compareVersions(version, base) >= 0;
  }
  if (range.startsWith(">=")) return compareVersions(version, range.slice(2)) >= 0;
  if (range.startsWith("<=")) return compareVersions(version, range.slice(2)) <= 0;
  return compareVersions(version, range) === 0;
}
`,
      "lib/resolve.mjs": `import { compareVersions, satisfiesRange } from "./semver.mjs";

/**
 * Pick the highest registry version that satisfies the range. Versions are
 * unique, so there are no ties. Throws when nothing satisfies — an empty
 * pick must never happen silently.
 */
export function resolveRange(range, versions) {
  const candidates = versions.filter((v) => satisfiesRange(v, range));
  if (candidates.length === 0) throw new Error("no version satisfies " + range);
  return candidates.sort(compareVersions)[candidates.length - 1];
}
`,
      "check.mjs": `import { compareVersions } from "./lib/semver.mjs";
import { resolveRange } from "./lib/resolve.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const releaseVsPrerelease = compareVersions("1.0.0", "1.0.0-rc.1");
if (releaseVsPrerelease <= 0) fail("a release must sort ABOVE its prerelease, got " + releaseVsPrerelease);
if (resolveRange(">=1.9.0-beta.1", ["1.9.0-beta.2", "1.9.0"]) !== "1.9.0") {
  fail("even a prerelease-naming range must prefer the release, got " + resolveRange(">=1.9.0-beta.1", ["1.9.0-beta.2", "1.9.0"]));
}

console.log("PASS: prerelease binds below the release");
`,
    },
    {
      "lib/semver.mjs": [
        [
          "  if (A.prerelease === null) return 1;",
          "  if (B.prerelease === null) return -1;",
        ].join("\n"),
        [
          "  if (A.prerelease === null) return -1;",
          "  if (B.prerelease === null) return 1;",
        ].join("\n"),
      ],
    },
    `import { parseVersion, compareVersions, satisfiesRange } from "./lib/semver.mjs";
import { resolveRange } from "./lib/resolve.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (compareVersions("1.0.0", "1.0.0-rc.1") <= 0) fail("release must bind ABOVE its prerelease");
if (compareVersions("1.0.0-rc.1", "1.0.0") >= 0) fail("prerelease must sort below the release");
if (compareVersions("1.0.0-alpha", "1.0.0-beta") >= 0) fail("alpha < beta");
if (compareVersions("1.2.3", "1.2.3") !== 0) fail("equal versions");
if (compareVersions("1.10.0", "1.9.0") <= 0) fail("numeric compare, not lexicographic");
if (compareVersions("2.0.0", "1.99.99") <= 0) fail("major wins");

const p = parseVersion("1.2.3-rc.1");
if (p.major !== 1 || p.minor !== 2 || p.patch !== 3 || p.prerelease !== "rc.1") fail("parseVersion broken");
if (parseVersion("0.0.1").prerelease !== null) fail("release must have no prerelease");

const registry = ["1.2.0", "1.4.1", "1.9.0", "1.9.0-beta.2", "2.0.0-rc.1"];
if (resolveRange("^1.2.0", registry) !== "1.9.0") fail("^1.2.0 must pick 1.9.0, got " + resolveRange("^1.2.0", registry));
if (resolveRange("~1.2.0", registry) !== "1.2.0") fail("~1.2.0 must pick 1.2.0");
if (resolveRange("~1.4.0", registry) !== "1.4.1") fail("~1.4.0 must pick 1.4.1");
if (resolveRange("*", registry) !== "1.9.0") fail("* must pick the highest release");
if (resolveRange("1.4.1", registry) !== "1.4.1") fail("exact pick");
if (resolveRange(">=1.4.1", registry) !== "1.9.0") fail(">= pick");
if (resolveRange("<=1.4.1", registry) !== "1.4.1") fail("<= pick");
if (resolveRange(">=2.0.0-rc.1", registry) !== "2.0.0-rc.1") fail("a range that names a prerelease may resolve to it");

let threw = false;
try { resolveRange("^3.0.0", registry); } catch { threw = true; }
if (!threw) fail("unsatisfied range must throw");
threw = false;
try { resolveRange("^1.9.0", ["1.9.0-beta.2"]); } catch { threw = true; }
if (!threw) fail("a bare prerelease must not satisfy ^1.9.0");
if (!satisfiesRange("1.9.0", "^1.2.0") || satisfiesRange("2.0.0", "^1.2.0")) fail("satisfiesRange sanity");

console.log("PASS: prerelease binds below the release; ranges resolve to the highest match");
`,
  ),

  def(
    "hard",
    "inventory-oversell",
    "Orders oversell stock: the reserve guard checks the wrong thing",
    "Run `node check.mjs`. Support escalated an oversell: an order for more units than are free went through and the ledger went negative. lib/stock.mjs documents the contract — reserve is atomic: either the full qty leaves the free pool, or nothing changes and it throws. A cleanup 'simplified' the guard and broke exactly that. Fix lib/stock.mjs, keep the interfaces, and verify with your own script that a failed reserve (single line or mid-order via placeOrder in src/orders.mjs) leaves every level and reservation list untouched.",
    {
      "src/catalog-data.mjs": `export const CATALOG = {
  "mug-01": { title: "Enamel mug", stock: 5 },
  "tee-02": { title: "T-shirt M", stock: 3 },
  "cap-03": { title: "Cap", stock: 0 },
  "sock-04": { title: "Wool socks", stock: 12 },
};
`,
      "src/stock.mjs": `import { CATALOG } from "./catalog-data.mjs";

/**
 * Stock ledger over the catalog. reserve() is a contract: EITHER the full
 * qty is available and leaves the free pool, OR nothing changes and it
 * throws — a negative free level is an oversell, the one thing this module
 * must never allow.
 */
export function createStock() {
  const free = new Map(Object.entries(CATALOG).map(([sku, item]) => [sku, item.stock]));
  const reservations = new Map();

  return {
    freeLevel(sku) {
      if (!free.has(sku)) throw new Error("unknown sku: " + sku);
      return free.get(sku);
    },
    restock(sku, qty) {
      if (!free.has(sku)) throw new Error("unknown sku: " + sku);
      if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
      free.set(sku, free.get(sku) + qty);
    },
    reserve(sku, qty, orderId) {
      if (!free.has(sku)) throw new Error("unknown sku: " + sku);
      if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("qty must be a positive integer");
      if (free.get(sku) < qty) {
        throw new Error("insufficient stock for " + sku + ": free " + free.get(sku) + ", want " + qty);
      }
      free.set(sku, free.get(sku) - qty);
      const forOrder = reservations.get(orderId) ?? [];
      forOrder.push({ sku, qty });
      reservations.set(orderId, forOrder);
    },
    release(orderId) {
      for (const { sku, qty } of reservations.get(orderId) ?? []) {
        free.set(sku, free.get(sku) + qty);
      }
      reservations.delete(orderId);
    },
    reservationsOf(orderId) {
      return [...(reservations.get(orderId) ?? [])];
    },
  };
}
`,
      "src/orders.mjs": `/**
 * Orders reserve stock line by line. An order is all-or-nothing: if any
 * line cannot be reserved, the lines already reserved for THIS order are
 * released again and the error propagates.
 */
export function placeOrder(stock, { id, lines }) {
  if (!id) throw new Error("order id required");
  try {
    for (const line of lines) {
      stock.reserve(line.sku, line.qty, id);
    }
  } catch (err) {
    stock.release(id);
    throw err;
  }
  return { id, lines: lines.map((l) => ({ ...l })) };
}
`,
      "check.mjs": `import { createStock } from "./src/stock.mjs";
import { placeOrder } from "./src/orders.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const stock = createStock();
placeOrder(stock, { id: "o1", lines: [{ sku: "mug-01", qty: 2 }, { sku: "tee-02", qty: 1 }] });
if (stock.freeLevel("mug-01") !== 3) fail("mug stock after order: " + stock.freeLevel("mug-01"));
stock.release("o1");
if (stock.freeLevel("mug-01") !== 5 || stock.freeLevel("tee-02") !== 3) fail("release must restore stock");

try {
  placeOrder(stock, { id: "o2", lines: [{ sku: "mug-01", qty: 99 }] });
  fail("oversell must throw");
} catch {}

console.log("PASS: orders reserve atomically");
`,
    },
    {
      "src/stock.mjs": [
        "      if (free.get(sku) < qty) {",
        "      if (free.get(sku) <= 0) { // simplified guard",
      ],
    },
    `import { createStock } from "./src/stock.mjs";
import { placeOrder } from "./src/orders.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const s = createStock();
if (s.freeLevel("cap-03") !== 0) fail("cap starts at 0");
if (s.freeLevel("sock-04") !== 12) fail("socks start at 12");

const o1 = placeOrder(s, { id: "o1", lines: [{ sku: "mug-01", qty: 2 }, { sku: "sock-04", qty: 4 }] });
if (o1.lines.length !== 2) fail("order must echo its lines");
if (s.freeLevel("mug-01") !== 3 || s.freeLevel("sock-04") !== 8) fail("levels after o1: " + s.freeLevel("mug-01") + "/" + s.freeLevel("sock-04"));
if (JSON.stringify(s.reservationsOf("o1")) !== JSON.stringify([{ sku: "mug-01", qty: 2 }, { sku: "sock-04", qty: 4 }])) fail("reservations must be recorded per order");

let threw = false;
try { s.reserve("mug-01", 4, "o2"); } catch { threw = true; }
if (!threw) fail("reserving 4 mugs with 3 free must throw");
if (s.freeLevel("mug-01") !== 3) fail("a failed reserve must leave the level untouched, got " + s.freeLevel("mug-01"));
if (s.reservationsOf("o2").length !== 0) fail("a failed reserve must not record a reservation");

threw = false;
try { s.reserve("cap-03", 1, "o3"); } catch { threw = true; }
if (!threw) fail("reserving an out-of-stock sku must throw");

threw = false;
try { placeOrder(s, { id: "o4", lines: [{ sku: "tee-02", qty: 2 }, { sku: "tee-02", qty: 2 }] }); }
catch { threw = true; }
if (!threw) fail("an order that cannot fully reserve must throw");
if (s.freeLevel("tee-02") !== 3) fail("a failed order must release partial reservations, tee free = " + s.freeLevel("tee-02"));
if (s.reservationsOf("o4").length !== 0) fail("a failed order must leave no reservations");

s.release("o1");
if (s.freeLevel("mug-01") !== 5 || s.freeLevel("sock-04") !== 12) fail("release must restore the levels");
s.release("ghost");

threw = false;
try { s.reserve("mug-01", 1, "o5"); s.reserve("mug-01", 0, "o5"); } catch { threw = true; }
if (!threw) fail("qty 0 must throw");
threw = false;
try { s.freeLevel("nope-99"); } catch { threw = true; }
if (!threw) fail("unknown sku must throw");

console.log("PASS: reserve is atomic, orders are all-or-nothing");
`,
  ),

  def(
    "hard",
    "metrics-percentiles",
    "Latency percentiles collapsed: p95 of the big log reads like a median",
    "Run `node check.mjs`. The on-call dashboard shows suspiciously good numbers: GET /api/items reports p95 near its median, and POST /api/orders looks faster than /api/health. The events are in data/events.log (thousands of lines — do not read it whole, parse it). lib/percentile.mjs implements nearest-rank over an ASCENDING array and is correct; the per-endpoint pipeline in lib/report.mjs lost that precondition somewhere between parsing and reporting. Fix the cause in lib/report.mjs and verify with node check.mjs plus your own script (unit anchors for percentile, exact per-endpoint stats recomputed independently).",
    {
      "lib/percentile.mjs": `/**
 * Nearest-rank percentile over an ASCENDING-sorted array (the function
 * does not sort — callers must). rank = ceil(p/100 * n), clamped to
 * [1, n]; result = values[rank - 1].
 */
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) throw new RangeError("values must be a non-empty array");
  if (!(p > 0 && p <= 100)) throw new RangeError("p must be in (0, 100]");
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}
`,
      "lib/report.mjs": `import { readFileSync } from "node:fs";
import { percentile } from "./percentile.mjs";

const LINE = /^(\\d+) endpoint="([^"]+)" latency_ms=(\\d+)$/;

/** Drop anything that is not an event line; return { ts, endpoint, latencyMs }. */
export function parseEvents(text) {
  const events = [];
  for (const line of String(text).split("\\n")) {
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
    const sorted = [...latencies].sort((a, b) => a - b);
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
`,
      "data/events.log": buildEventsLog(),
      "check.mjs": `import { loadEvents, endpointStats } from "./lib/report.mjs";

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
`,
    },
    {
      "lib/report.mjs": [
        "    const sorted = [...latencies].sort((a, b) => a - b);",
        "    const sorted = [...latencies].sort(); // lexicographic is fine for uniform widths",
      ],
    },
    `import { percentile } from "./lib/percentile.mjs";
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
if (parseEvents("not a line\\n").length !== 0) fail("garbage must be dropped");

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
`,
    300_000,
  ),

  def(
    "hard",
    "txn-ledger-ordering",
    "End-of-day balances drift when the file arrives out of order",
    "Accounting flagged two days whose end-of-day balances don't match the sum of that day's transactions. data/transactions.jsonl arrived in a strange order, and src/ledger.mjs documents the rule that must hold regardless: transactions apply strictly in NUMERIC seq order — the running balances and the per-day snapshots in the result both depend on it. Reproduce by feeding applyTxns a shuffled array, find where the ordering rule is lost, fix it, and verify with your own script (applied order, final balances, end-of-day snapshots for every day, negative-balance and malformed-input guards).",
    {
      "data/transactions.jsonl": [
        JSON.stringify({ seq: 1, kind: "deposit", account: "cash", amount: 10000, day: "2026-09-28" }),
        JSON.stringify({ seq: 2, kind: "deposit", account: "escrow", amount: 5000, day: "2026-09-28" }),
        JSON.stringify({ seq: 3, kind: "withdraw", account: "cash", amount: 2500, day: "2026-09-28" }),
        JSON.stringify({ seq: 4, kind: "deposit", account: "cash", amount: 1000, day: "2026-09-29" }),
        JSON.stringify({ seq: 5, kind: "withdraw", account: "escrow", amount: 2000, day: "2026-09-29" }),
        JSON.stringify({ seq: 6, kind: "deposit", account: "cash", amount: 4000, day: "2026-09-29" }),
        JSON.stringify({ seq: 7, kind: "withdraw", account: "cash", amount: 1500, day: "2026-09-30" }),
        JSON.stringify({ seq: 8, kind: "deposit", account: "escrow", amount: 1000, day: "2026-09-30" }),
        JSON.stringify({ seq: 9, kind: "deposit", account: "cash", amount: 3000, day: "2026-09-30" }),
        JSON.stringify({ seq: 10, kind: "withdraw", account: "cash", amount: 2500, day: "2026-09-30" }),
        JSON.stringify({ seq: 11, kind: "deposit", account: "escrow", amount: 700, day: "2026-09-30" }),
        JSON.stringify({ seq: 12, kind: "withdraw", account: "escrow", amount: 2700, day: "2026-09-30" }),
      ].join("\n") + "\n",
      "src/ledger.mjs": `import { readFileSync } from "node:fs";

/**
 * \`seq\` is a global sequence number: transactions apply strictly in
 * numeric seq order, whatever order the file or the API returned them in.
 * Running balances and the per-day snapshots both depend on that order.
 */
export function loadTxns(path) {
  return readFileSync(path, "utf8")
    .split("\\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export function applyTxns(txns) {
  for (const t of txns) {
    if (!Number.isInteger(t.seq)) throw new TypeError("seq must be an integer");
    if (t.kind !== "deposit" && t.kind !== "withdraw") throw new TypeError("unknown kind: " + t.kind);
    if (!Number.isInteger(t.amount) || t.amount <= 0) throw new TypeError("amount must be a positive integer");
  }
  const ordered = [...txns].sort((a, b) => a.seq - b.seq);
  const balances = new Map();
  const daily = new Map();
  for (const t of ordered) {
    const current = balances.get(t.account) ?? 0;
    const next = current + (t.kind === "deposit" ? t.amount : -t.amount);
    if (next < 0) throw new Error("account " + t.account + " would go negative at seq " + t.seq);
    balances.set(t.account, next);
    if (!daily.has(t.day)) daily.set(t.day, new Map());
    daily.get(t.day).set(t.account, next);
  }
  return { balances, daily, appliedOrder: ordered.map((t) => t.seq) };
}
`,
      "src/report.mjs": `/** End-of-day balances for one day, as a plain alphabetically-sorted object. */
export function dailySnapshot(run, day) {
  const snapshot = run.daily.get(day);
  if (!snapshot) throw new Error("no activity on " + day);
  return Object.fromEntries([...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
`,
    },
    {
      "src/ledger.mjs": [
        "  const ordered = [...txns].sort((a, b) => a.seq - b.seq);",
        "  const ordered = [...txns].sort((a, b) => String(a.seq).localeCompare(String(b.seq)));",
      ],
    },
    `import { applyTxns, loadTxns } from "./src/ledger.mjs";
import { dailySnapshot } from "./src/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const txns = loadTxns("data/transactions.jsonl");
if (txns.length !== 12) fail("expected 12 transactions, got " + txns.length);
const shuffled = [txns[5], txns[0], txns[11], txns[2], txns[7], txns[1], txns[9], txns[3], txns[8], txns[4], txns[10], txns[6]];
const run = applyTxns(shuffled);
if (!eq(run.appliedOrder, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) fail("txns must apply in numeric seq order, got " + run.appliedOrder.join(","));
if (run.balances.get("cash") !== 11500) fail("cash must end at 11500, got " + run.balances.get("cash"));
if (run.balances.get("escrow") !== 2000) fail("escrow must end at 2000, got " + run.balances.get("escrow"));
if (run.daily.get("2026-09-28").get("cash") !== 7500) fail("end-of-day cash on 09-28 must be 7500, got " + run.daily.get("2026-09-28").get("cash"));
if (run.daily.get("2026-09-29").get("cash") !== 12500) fail("end-of-day cash on 09-29 must be 12500, got " + run.daily.get("2026-09-29").get("cash"));
if (run.daily.get("2026-09-29").get("escrow") !== 3000) fail("end-of-day escrow on 09-29 must be 3000, got " + run.daily.get("2026-09-29").get("escrow"));
if (run.daily.get("2026-09-30").get("cash") !== 11500) fail("end-of-day cash on 09-30 must be 11500");
if (eq(dailySnapshot(run, "2026-09-29"), { cash: 12500, escrow: 3000 }) !== true) fail("dailySnapshot broken: " + JSON.stringify(dailySnapshot(run, "2026-09-29")));

let threw = false;
try {
  applyTxns([{ seq: 1, kind: "withdraw", account: "cash", amount: 100, day: "2026-10-01" }]);
} catch { threw = true; }
if (!threw) fail("an account must never go negative");

threw = false;
try { applyTxns([{ seq: 1.5, kind: "deposit", account: "cash", amount: 100, day: "2026-10-01" }]); } catch { threw = true; }
if (!threw) fail("fractional seq must throw");
threw = false;
try { applyTxns([{ seq: 1, kind: "transfer", account: "cash", amount: 100, day: "2026-10-01" }]); } catch { threw = true; }
if (!threw) fail("unknown kind must throw");

console.log("PASS: numeric seq order survives any input order");
`,
  ),

  def(
    "hard",
    "single-flight-cache",
    "One dashboard load fires dozens of identical fetches",
    "Opening the dashboard fires one fetch per widget instead of one shared fetch per key: a burst of concurrent get(key) calls must collapse into a single underlying load while it is in flight. lib/singleflight.mjs documents the full contract: share the in-flight promise, cache successful values, never cache rejections, drop the in-flight entry once it settles so the next get starts fresh, and keep distinct keys independent. Fix lib/singleflight.mjs and verify with your own script using deferred promises and a load counter (concurrent collapse, post-settle reload, rejection not cached, distinct keys).",
    {
      "lib/singleflight.mjs": `/**
 * Collapse concurrent loads of the same key into ONE underlying call:
 * while a load is in flight, every get(key) awaits the same promise. The
 * value is cached after success; a REJECTED load is never cached, and once
 * the in-flight load settles, the entry is dropped so the next get starts
 * fresh.
 */
export function createSingleFlight(load) {
  const cache = new Map();
  const inflight = new Map();

  return {
    get(key) {
      if (cache.has(key)) return Promise.resolve(cache.get(key));
      if (inflight.has(key)) return inflight.get(key);
      const pending = (async () => {
        try {
          const value = await load(key);
          cache.set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
      return pending;
    },
    peek(key) {
      return cache.get(key);
    },
  };
}
`,
    },
    {
      "lib/singleflight.mjs": [
        "      if (inflight.has(key)) return inflight.get(key);",
        "      // each caller loads for itself (PROD-4402)",
      ],
    },
    `import { createSingleFlight } from "./lib/singleflight.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let loadCalls = 0;
const gates = new Map();
const loader = async (key) => {
  loadCalls++;
  if (!gates.has(key)) gates.set(key, []);
  return new Promise((resolve, reject) => gates.get(key).push({ resolve, reject }));
};

const flights = createSingleFlight(loader);
const waiting = [flights.get("k"), flights.get("k"), flights.get("k"), flights.get("k")];
if (loadCalls !== 1) fail("concurrent gets must share ONE load, got " + loadCalls);
if (flights.peek("k") !== undefined) fail("nothing may be cached while the load is in flight");
gates.get("k")[0].resolve("v1");
const values = await Promise.all(waiting);
if (values.join(",") !== "v1,v1,v1,v1") fail("all waiters must resolve with the loaded value");
if (flights.peek("k") !== "v1") fail("a successful load must be cached");

const again = await flights.get("k");
if (again !== "v1" || loadCalls !== 1) fail("a cached value must be served without a new load");

const r1 = flights.get("r");
if (loadCalls !== 2) fail("an uncached key must start a fresh load, calls=" + loadCalls);
gates.get("r")[0].reject(new Error("boom"));
let threw = false;
try { await r1; } catch (err) { threw = err.message === "boom"; }
if (!threw) fail("a rejected load must propagate");
if (flights.peek("r") !== undefined) fail("a rejected load must not be cached");
const r2 = flights.get("r");
if (loadCalls !== 3) fail("after a rejected load the next get must start fresh, calls=" + loadCalls);
gates.get("r")[1].resolve("r-ok");
if ((await r2) !== "r-ok") fail("a retry after rejection must resolve");

let boomCalls = 0;
const failing = createSingleFlight(async () => {
  boomCalls++;
  if (boomCalls === 1) throw new Error("first fails");
  return "recovered";
});
threw = false;
try { await failing.get("j"); } catch { threw = true; }
if (!threw) fail("the first failing load must throw");
if ((await failing.get("j")) !== "recovered") fail("after a rejection the next get must load fresh");
if (boomCalls !== 2) fail("rejected load must not be cached, calls=" + boomCalls);

const other = flights.get("other");
if (loadCalls !== 4) fail("distinct keys must load independently");
gates.get("other")[0].resolve("o");
if ((await other) !== "o") fail("distinct key value");

console.log("PASS: concurrent loads collapse into one; rejections stay uncached");
`,
  ),

  def(
    "hard",
    "sales-rollup",
    "July report shows refund revenue that belongs to earlier months",
    "Run `node check.mjs`. Finance says the July report books hundreds of refunds that actually belong to Jan-Jun orders, and the monthly cells for those months are inflated. The policy is documented in src/rollup.mjs: orders book in their own month; a refund nets against the ORIGINAL order's month and region (join by refund_of), never against the refund's own date. The data is src/orders.jsonl (thousands of lines — aggregate it, do not eyeball it). Find where the policy is lost, fix it, re-run the check, and verify with your own script against an independent recomputation.",
    {
      "src/rollup.mjs": `import { readFileSync } from "node:fs";

/**
 * Net revenue per month and region, in cents. Orders book in the month of
 * their own date. A refund is NOT booked on its own date: it nets against
 * the ORIGINAL order's month and region (join by refund_of) — revenue is
 * measured when it was earned. Keys look like "2026-03|eu".
 */
export function loadRows(path) {
  return readFileSync(path, "utf8")
    .split("\\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export function netByMonthRegion(rows) {
  const orderById = new Map();
  for (const row of rows) {
    if (row.type === "order") orderById.set(row.id, row);
  }
  const net = new Map();
  const add = (month, region, cents) => {
    const key = month + "|" + region;
    net.set(key, (net.get(key) ?? 0) + cents);
  };
  for (const row of rows) {
    if (row.type === "order") {
      add(row.date.slice(0, 7), row.region, row.amount);
    } else if (row.type === "refund") {
      const original = orderById.get(row.refund_of);
      if (!original) throw new Error("refund " + row.id + " references unknown order " + row.refund_of);
      add(original.date.slice(0, 7), original.region, row.amount);
    } else {
      throw new Error("unknown row type: " + row.type);
    }
  }
  return net;
}
`,
      "src/orders.jsonl": buildOrdersJsonl(),
      "check.mjs": `import { loadRows, netByMonthRegion } from "./src/rollup.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = loadRows("src/orders.jsonl");
if (rows.length !== 2640) fail("expected 2640 rows, got " + rows.length);
const net = netByMonthRegion(rows);
for (const key of net.keys()) {
  if (key.startsWith("2026-07")) fail("refunds must net against the original order's month, found " + key);
}
let total = 0;
for (const v of net.values()) total += v;
const orders = rows.filter((r) => r.type === "order").reduce((s, r) => s + r.amount, 0);
const refunds = rows.filter((r) => r.type === "refund").reduce((s, r) => s + r.amount, 0);
if (total !== orders + refunds) fail("net must equal orders minus refunds");

console.log("PASS: refunds net into the original months");
`,
    },
    {
      "src/rollup.mjs": [
        "      add(original.date.slice(0, 7), original.region, row.amount);",
        "      add(row.date.slice(0, 7), original.region, row.amount); // refunds book on their own date (PROD-4430)",
      ],
    },
    `import { loadRows, netByMonthRegion } from "./src/rollup.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = loadRows("src/orders.jsonl");
if (rows.length !== 2640) fail("expected 2640 rows");
const orders = rows.filter((r) => r.type === "order");
const refunds = rows.filter((r) => r.type === "refund");
if (orders.length !== 2400 || refunds.length !== 240) fail("row mix wrong");

const byId = new Map(orders.map((o) => [o.id, o]));
const expected = new Map();
const add = (key, cents) => expected.set(key, (expected.get(key) ?? 0) + cents);
for (const o of orders) add(o.date.slice(0, 7) + "|" + o.region, o.amount);
for (const r of refunds) {
  const o = byId.get(r.refund_of);
  add(o.date.slice(0, 7) + "|" + o.region, r.amount);
}

const got = netByMonthRegion(rows);
if (got.size !== expected.size) fail("cell count " + got.size + " != " + expected.size);
for (const [key, value] of expected) {
  if (got.get(key) !== value) fail(key + ": got " + got.get(key) + ", expected " + value);
}
if (got.size !== 24) fail("expected 6 months x 4 regions = 24 cells, got " + got.size);
if ([...got.keys()].some((k) => !/^2026-0[1-6]\\|/.test(k))) fail("unexpected keys: " + [...got.keys()].filter((k) => !/^2026-0[1-6]\\|/.test(k)).join(","));

let total = 0;
for (const v of got.values()) total += v;
const orderSum = orders.reduce((s, o) => s + o.amount, 0);
const refundSum = refunds.reduce((s, r) => s + r.amount, 0);
if (total !== orderSum + refundSum) fail("net must equal orders minus refunds");

let threw = false;
try {
  netByMonthRegion([{ type: "refund", id: "r", refund_of: "ghost", date: "2026-01-01", amount: -1 }]);
} catch { threw = true; }
if (!threw) fail("a refund without its order must throw");

console.log("PASS: refunds net into the original order's month and region");
`,
    300_000,
  ),

  def(
    "hard",
    "circuit-breaker",
    "Half-open state lets a whole retry storm through",
    "After a backend outage recovered, the circuit breaker let a burst of client calls hit the recovering service at once instead of sending a single probe — the retry storm tripped it again. lib/breaker.mjs documents the state machine: closed (threshold consecutive failures open it), open (everything rejects with Error('circuit open') without touching the delegate until cooldownMs elapses), half-open (exactly ONE probe runs; success closes, failure reopens with a fresh cooldown; every other call still rejects). The clock is injectable. Fix lib/breaker.mjs and verify the full state machine with your own script: counting delegate, calls during open, calls during an in-flight probe, cooldown restarts, success/failure probe paths.",
    {
      "lib/breaker.mjs": `/**
 * Circuit breaker around async calls.
 * closed — calls pass through; \`threshold\` consecutive failures open the
 *   circuit; any success resets the failure counter.
 * open — every call throws Error("circuit open") WITHOUT invoking the
 *   delegate; after \`cooldownMs\` since opening, the circuit turns
 *   half-open.
 * half-open — exactly ONE probe call may run; its success closes the
 *   circuit, its failure reopens it with a fresh cooldown. Every other
 *   call during half-open throws Error("circuit open").
 * The clock is injectable.
 */
export function createBreaker({ threshold = 3, cooldownMs = 30_000, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("threshold must be a positive integer");
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new RangeError("cooldownMs must be positive");
  let state = "closed";
  let failures = 0;
  let openedAt = 0;
  let probing = false;

  return {
    get state() { return state; },
    async call(fn) {
      if (state === "open" && now() - openedAt >= cooldownMs) {
        state = "half-open";
        probing = false;
      }
      if (state === "open") throw new Error("circuit open");
      if (state === "half-open") {
        if (probing) throw new Error("circuit open");
        probing = true;
        try {
          const value = await fn();
          state = "closed";
          failures = 0;
          probing = false;
          return value;
        } catch (err) {
          state = "open";
          openedAt = now();
          probing = false;
          throw err;
        }
      }
      try {
        const value = await fn();
        failures = 0;
        return value;
      } catch (err) {
        failures++;
        if (failures >= threshold) {
          state = "open";
          openedAt = now();
        }
        throw err;
      }
    },
  };
}
`,
    },
    {
      "lib/breaker.mjs": [
        [
          "      if (state === \"half-open\") {",
          "        if (probing) throw new Error(\"circuit open\");",
          "        probing = true;",
        ].join("\n"),
        [
          "      if (state === \"half-open\") {",
          "        // half-open lets traffic through again",
          "        probing = true;",
        ].join("\n"),
      ],
    },
    `import { createBreaker } from "./lib/breaker.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
let calls = 0;
let mode = "ok";
const delegate = async () => {
  calls++;
  if (mode === "fail") throw new Error("backend down");
  return "ok";
};
const breaker = createBreaker({ threshold: 3, cooldownMs: 100, now: () => t });

await breaker.call(delegate);
await breaker.call(delegate);
if (breaker.state !== "closed" || calls !== 2) fail("closed state broken");
mode = "fail";
for (let i = 0; i < 3; i++) {
  try { await breaker.call(delegate); } catch (err) {
    if (err.message !== "backend down") fail("delegate errors must propagate: " + err.message);
  }
}
if (breaker.state !== "open") fail("3 consecutive failures must open the circuit, state=" + breaker.state);
const callsAtOpen = calls;

for (let i = 0; i < 5; i++) {
  try { await breaker.call(delegate); fail("open circuit must reject"); }
  catch (err) {
    if (err.message !== "circuit open") fail("open circuit must reject with 'circuit open', got: " + err.message);
  }
}
if (calls !== callsAtOpen) fail("open circuit must short-circuit without calling the backend");

t = 99;
try { await breaker.call(delegate); fail("circuit must stay open before the cooldown elapses"); }
catch (err) { if (err.message !== "circuit open") fail("wrong error before cooldown: " + err.message); }

t = 100;
if (breaker.state !== "open") fail("state must stay open until a call observes the cooldown");
mode = "ok";
const probe = breaker.call(delegate);
try { await breaker.call(delegate); fail("a second call during the probe must be rejected"); }
catch (err) { if (err.message !== "circuit open") fail("half-open must admit exactly one probe: " + err.message); }
await probe;
if (breaker.state !== "closed") fail("a successful probe must close the circuit, state=" + breaker.state);

mode = "fail";
for (let i = 0; i < 3; i++) { try { await breaker.call(delegate); } catch {} }
if (breaker.state !== "open") fail("failures must reopen the circuit");
t = 150;
try { await breaker.call(delegate); fail("fresh cooldown must be respected, t=" + t); }
catch (err) { if (err.message !== "circuit open") fail("wrong error mid-cooldown"); }
t = 200;
const probe2 = breaker.call(delegate);
try { await breaker.call(delegate); fail("second call during the failing probe must be rejected"); }
catch (err) { if (err.message !== "circuit open") fail("half-open gate broken on the failure path"); }
let reopened = false;
try { await probe2; } catch { reopened = true; }
if (!reopened || breaker.state !== "open") fail("a failing probe must reopen the circuit, state=" + breaker.state);

let threw = false;
try { createBreaker({ threshold: 0 }); } catch { threw = true; }
if (!threw) fail("threshold must be a positive integer");

console.log("PASS: open/half-open/closed transitions admit exactly one probe");
`,
  ),

  def(
    "hard",
    "migration-runner",
    "Fresh environments diverge: migrations apply in lexicographic order",
    "Run `node check.mjs`. A fresh staging environment crashed mid-migration, while prod (migrated incrementally) is fine. The runner's contract is in lib/runner.mjs: migrations apply in strict NUMERIC id order — lexicographic would run 10 before 2 — and several steps in migrations.mjs depend on tables created by earlier steps. Fix the runner, keep every other guarantee (checksum freeze on edited applied migrations, idempotent re-runs against a full journal, duplicate-id rejection), re-run the check, and verify the rest with your own script.",
    {
      "migrations.mjs": `/**
 * The schema migrations. Ids are plain integers and MUST apply in numeric
 * order — several steps depend on tables created by earlier steps.
 */
export function makeMigrations() {
  return [
    { id: 1, up: (db) => { db.users = { columns: ["id", "email"] }; } },
    { id: 2, up: (db) => { db.users.columns.push("name"); } },
    { id: 3, up: (db) => { db.orders = { columns: ["id", "user_id", "total_cents"], indexes: [] }; } },
    { id: 4, up: (db) => { db.orders.columns.push("status"); } },
    { id: 5, up: (db) => { if (!db.users) throw new Error("users table missing"); db.users.indexes = ["users_email_key"]; } },
    { id: 6, up: (db) => { db.orders.indexes.push("orders_user_idx"); } },
    { id: 7, up: (db) => { db.coupons = { columns: ["id", "code", "percent"] }; } },
    { id: 8, up: (db) => { db.orders.columns.push("coupon_id"); } },
    { id: 9, up: (db) => { db.audit = { events: [] }; } },
    { id: 10, up: (db) => { if (!db.orders) throw new Error("orders table missing"); db.orders.indexes.push("orders_status_idx"); } },
    { id: 11, up: (db) => { db.audit.events.push("backfill"); } },
    { id: 12, up: (db) => { if (!db.coupons) throw new Error("coupons table missing"); db.coupons.columns.push("expires_at"); } },
  ];
}
`,
      "lib/runner.mjs": `/**
 * Migration runner. Contract:
 * - migrations apply in strict NUMERIC id order (not lexicographic —
 *   "10" sorts before "2" as a string);
 * - an already-applied migration whose source changed since must abort
 *   with Error (checksum mismatch) — editing applied migrations is a
 *   freeze violation;
 * - applying the same set twice is a no-op the second time;
 * - the returned journal records { id, checksum } per applied migration.
 */
export function migrate(migrations, journal = []) {
  const appliedChecksums = new Map(journal.map((entry) => [entry.id, entry.checksum]));
  const ordered = [...migrations].sort((a, b) => a.id - b.id);
  const ids = new Set(migrations.map((m) => m.id));
  if (ids.size !== migrations.length) throw new Error("duplicate migration id");
  const db = {};
  const nextJournal = [...journal];
  for (const migration of ordered) {
    const checksum = sourceChecksum(migration);
    if (appliedChecksums.has(migration.id)) {
      if (appliedChecksums.get(migration.id) !== checksum) {
        throw new Error("migration " + migration.id + " changed after it was applied");
      }
      continue;
    }
    migration.up(db);
    nextJournal.push({ id: migration.id, checksum });
  }
  return { db, journal: nextJournal };
}

export function sourceChecksum(migration) {
  return String(migration.id) + ":" + migration.up.toString().replace(/\\s+/g, " ").trim();
}
`,
      "check.mjs": `import { migrate } from "./lib/runner.mjs";
import { makeMigrations } from "./migrations.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const run = migrate(makeMigrations());
if (run.journal.map((j) => j.id).join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12") {
  fail("migration order wrong: " + run.journal.map((j) => j.id).join(","));
}

console.log("PASS: migrations apply cleanly in numeric order");
`,
    },
    {
      "lib/runner.mjs": [
        "  const ordered = [...migrations].sort((a, b) => a.id - b.id);",
        "  const ordered = [...migrations].sort((a, b) => String(a.id).localeCompare(String(b.id)));",
      ],
    },
    `import { migrate, sourceChecksum } from "./lib/runner.mjs";
import { makeMigrations } from "./migrations.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const first = migrate(makeMigrations());
if (!eq(first.journal.map((j) => j.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
  fail("migrations must apply in numeric id order, got " + first.journal.map((j) => j.id).join(","));
}
if (first.db.users.columns.join(",") !== "id,email,name") fail("users columns wrong: " + first.db.users.columns);
if (first.db.orders.indexes.join(",") !== "orders_user_idx,orders_status_idx") fail("orders indexes wrong: " + first.db.orders.indexes);
if (first.db.coupons.columns.join(",") !== "id,code,percent,expires_at") fail("coupons columns wrong");
if (first.db.audit.events.join(",") !== "backfill") fail("audit wrong");

const second = migrate(makeMigrations(), first.journal);
if (second.journal.length !== first.journal.length) fail("a second run must not apply anything");
if (!eq(second.journal, first.journal)) fail("the journal must be preserved");
if (Object.keys(second.db).length !== 0) fail("a fully applied set must not touch the db");

const tampered = makeMigrations();
tampered[3] = { id: 4, up: (db) => { db.orders.columns.push("status", "extra"); } };
let threw = false;
try { migrate(tampered, first.journal); }
catch (err) { threw = /changed after it was applied/.test(err.message); }
if (!threw) fail("an edited applied migration must abort with a checksum error");

threw = false;
try { migrate([{ id: 1, up: () => {} }, { id: 1, up: () => {} }]); } catch { threw = true; }
if (!threw) fail("duplicate ids must throw");

if (typeof sourceChecksum({ id: 1, up: () => 1 }) !== "string") fail("checksum must be a string");

console.log("PASS: numeric order, checksum freeze, idempotent re-runs");
`,
  ),
];
