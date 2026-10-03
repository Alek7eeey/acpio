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

  def(
    "hard",
    "mark-sweep-gc",
    "Cache GC frees objects that are still two links away from a root",
    "Run `node check.mjs`. Since the last GC tuning, the object cache crashes minutes after every collection with 'object freed': whole subgraphs that the application still references vanish whenever they hang more than one link away from a root. lib/heap.mjs documents collect() as mark-and-sweep — everything reachable from a root through ANY chain of links survives, everything else is freed and its id throws afterwards. Reproduce with a chain, find where the marking stops early, fix it, re-run the check, and verify the rest with your own script (rooted chains and cycles, unrooted cycles collected, shared objects, freed ids ascend numerically, no id reuse after collect, removeRoot, freed/unknown ids throw).",
    {
      "lib/heap.mjs": `/**
 * Tiny tracing heap for the object cache. Objects carry payload plus links
 * to other object ids. collect() is mark-and-sweep: everything reachable
 * from a root — through ANY chain of links — survives; everything else is
 * freed. Freed or unknown ids throw on get/links/addRoot. collect() returns
 * the freed ids ascending by numeric id.
 */
export class GcHeap {
  constructor() {
    this.objects = new Map();
    this.roots = new Set();
    this.nextId = 1;
  }

  allocate(payload, links = []) {
    const id = "o" + this.nextId++;
    this.objects.set(id, { payload, links: [...links] });
    return id;
  }

  link(from, to) {
    this.assertLive(from);
    this.assertLive(to);
    this.objects.get(from).links.push(to);
  }

  addRoot(id) {
    this.assertLive(id);
    this.roots.add(id);
  }

  removeRoot(id) {
    this.roots.delete(id);
  }

  assertLive(id) {
    if (!this.objects.has(id)) throw new Error("object freed or unknown: " + id);
  }

  links(id) {
    this.assertLive(id);
    return [...this.objects.get(id).links];
  }

  get(id) {
    this.assertLive(id);
    return this.objects.get(id).payload;
  }

  /** Mark everything reachable from the roots, then sweep the rest. */
  collect() {
    const marked = new Set();
    const work = [...this.roots];
    while (work.length > 0) {
      const id = work.pop();
      if (marked.has(id)) continue;
      marked.add(id);
      const obj = this.objects.get(id);
      if (obj) work.push(...obj.links);
    }
    const freed = [];
    for (const [id] of this.objects) {
      if (!marked.has(id)) {
        this.objects.delete(id);
        freed.push(id);
      }
    }
    return freed.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }
}
`,
      "check.mjs": `import { GcHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new GcHeap();
const root = heap.allocate({ kind: "session" });
const cart = heap.allocate({ kind: "cart" });
const item = heap.allocate({ kind: "item" });
heap.link(root, cart);
heap.link(cart, item);
heap.addRoot(root);

if (heap.collect().length !== 0) fail("a rooted chain must lose nothing");
if (heap.get(item).kind !== "item") fail("the deep object must survive");

console.log("PASS: the rooted chain survives collection");
`,
    },
    {
      "lib/heap.mjs": [
        [
          "      marked.add(id);",
          "      const obj = this.objects.get(id);",
          "      if (obj) work.push(...obj.links);",
        ].join("\n"),
        "      marked.add(id);\n      // links resolve themselves on the next pass (PROD-4479)",
      ],
    },
    `import { GcHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new GcHeap();
const root = heap.allocate({ kind: "session" });
const cart = heap.allocate({ kind: "cart" });
const item = heap.allocate({ kind: "item" });
const junk1 = heap.allocate({ kind: "junk1" });
const junk2 = heap.allocate({ kind: "junk2" });
heap.link(root, cart);
heap.link(cart, item);
heap.addRoot(root);

let freed = heap.collect();
if (freed.join(",") !== "o4,o5") fail("collect must free exactly the unrooted objects: " + freed.join(","));
if (heap.get(item).kind !== "item") fail("the deep object must survive");
let threw = false;
try { heap.get(junk1); } catch { threw = true; }
if (!threw) fail("a freed id must throw");

heap.removeRoot(root);
freed = heap.collect();
if (freed.join(",") !== "o1,o2,o3") fail("the unrooted chain must be collected in numeric order: " + freed.join(","));
threw = false;
try { heap.get(item); } catch { threw = true; }
if (!threw) fail("a freed id must throw");
threw = false;
try { heap.addRoot("o1"); } catch { threw = true; }
if (!threw) fail("addRoot of a freed id must throw");

const h2 = new GcHeap();
const a = h2.allocate({ n: "a" });
const b = h2.allocate({ n: "b" });
h2.link(a, b);
h2.link(b, a);
h2.addRoot(a);
const c = h2.allocate({ n: "c" });
freed = h2.collect();
if (freed.join(",") !== c) fail("a rooted cycle must survive, freed " + freed.join(","));
if (h2.get(b).n !== "b") fail("a cycle member must survive");
h2.removeRoot(a);
freed = h2.collect();
if (freed.length !== 2) fail("the unrooted cycle must be collected: " + freed.join(","));

const h3 = new GcHeap();
const shared = h3.allocate({ s: 1 });
const r1 = h3.allocate({}, [shared]);
const r2 = h3.allocate({}, [shared]);
h3.addRoot(r1);
h3.addRoot(r2);
if (h3.collect().length !== 0) fail("an object behind two roots must survive once, not be double-freed");

const h4 = new GcHeap();
const garbage = [];
for (let i = 0; i < 12; i++) garbage.push(h4.allocate({ i }));
const swept = h4.collect();
if (swept.join(",") !== "o1,o2,o3,o4,o5,o6,o7,o8,o9,o10,o11,o12") fail("freed ids must ascend numerically: " + swept.join(","));
const fresh = h4.allocate({ fresh: true });
if (fresh !== "o13" || swept.includes(fresh)) fail("ids must never be reused after a collect");
if (h4.get(fresh).fresh !== true) fail("the fresh allocation must be readable");

console.log("PASS: marking follows every chain; sweeping frees exactly the rest");
`,
  ),

  def(
    "hard",
    "diff3-merge",
    "Three-way merge silently drops one side of a conflicting edit",
    "Run `node check.mjs`. Since the merge queue was wired up, rebasing a branch can lose a colleague's change without any warning: when both sides edited the same region, the merge takes ours and reports success. lib/merge3.mjs documents the policy — a region changed differently on both sides is a CONFLICT: the result carries ours' middle followed by theirs' between markers and conflict=true; a side must never be dropped silently. Reproduce with two different edits of the same lines, find where the conflict is swallowed, fix it, re-run the check, and verify the rest with your own script (no-change merge, one-sided edits on either side, identical edits from both sides, both appending different lines, both deleting the same region, inputs never mutated).",
    {
      "lib/merge3.mjs": `/**
 * Three-way line merge. Region algorithm: trim the common prefix and the
 * common suffix that ours and theirs share with BASE; what remains is the
 * changed middle on each side.
 *   - neither side changed            -> head + base middle + tail
 *   - only ours changed               -> head + ours middle + tail
 *   - only theirs changed             -> head + theirs middle + tail
 *   - both changed identically        -> head + ours middle + tail, no conflict
 *   - both changed differently        -> CONFLICT: "<<<<<<< ours", ours,
 *     "=======", theirs, ">>>>>>> theirs" between head and tail, and
 *     conflict=true. A side must NEVER be dropped silently.
 * The inputs are never mutated.
 */
export function merge3(base, ours, theirs) {
  const b = [...base];
  const o = [...ours];
  const t = [...theirs];

  let pre = 0;
  while (pre < b.length && pre < o.length && pre < t.length && o[pre] === b[pre] && t[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < b.length - pre &&
    suf < o.length - pre &&
    suf < t.length - pre &&
    o[o.length - 1 - suf] === b[b.length - 1 - suf] &&
    t[t.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const baseMid = b.slice(pre, b.length - suf);
  const oursMid = o.slice(pre, o.length - suf);
  const theirsMid = t.slice(pre, t.length - suf);
  const head = o.slice(0, pre);
  const tail = suf === 0 ? [] : o.slice(o.length - suf);

  const oursSame = joinEq(oursMid, baseMid);
  const theirsSame = joinEq(theirsMid, baseMid);
  if (oursSame && theirsSame) return { merged: [...head, ...oursMid, ...tail], conflict: false };
  if (oursSame) return { merged: [...head, ...theirsMid, ...tail], conflict: false };
  if (theirsSame || joinEq(oursMid, theirsMid)) return { merged: [...head, ...oursMid, ...tail], conflict: false };
  return {
    merged: [...head, "<<<<<<< ours", ...oursMid, "=======", ...theirsMid, ">>>>>>> theirs", ...tail],
    conflict: true,
  };
}

function joinEq(a, c) {
  return a.length === c.length && a.every((line, i) => line === c[i]);
}
`,
      "check.mjs": `import { merge3 } from "./lib/merge3.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const base = ["prices", "vat", "totals"];
const ours = ["prices", "vat 19", "totals"];
const theirs = ["prices", "vat 20", "totals"];
const merged = merge3(base, ours, theirs);
if (!merged.conflict) fail("two different edits of the vat line must conflict, got: " + JSON.stringify(merged.merged));
if (!merged.merged.includes("vat 19") || !merged.merged.includes("vat 20")) fail("a conflict must carry BOTH sides, got: " + merged.merged.join(" | "));

console.log("PASS: conflicting edits surface as conflicts, nothing is dropped");
`,
    },
    {
      "lib/merge3.mjs": [
        [
          "  return {",
          "    merged: [...head, \"<<<<<<< ours\", ...oursMid, \"=======\", ...theirsMid, \">>>>>>> theirs\", ...tail],",
          "    conflict: true,",
          "  };",
        ].join("\n"),
        "  // both sides rewrote the region; ours is newer, keep it (PROD-4480)\n  return { merged: [...head, ...oursMid, ...tail], conflict: false };",
      ],
    },
    `import { merge3 } from "./lib/merge3.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(merge3(["a", "b"], ["a", "b"], ["a", "b"]).merged, ["a", "b"])) fail("no-change merge broken");
if (merge3(["a", "b"], ["a", "b"], ["a", "b"]).conflict !== false) fail("no-change merge must not conflict");

const onlyOurs = merge3(["x"], ["x", "y"], ["x"]);
if (!eq(onlyOurs.merged, ["x", "y"]) || onlyOurs.conflict) fail("only-ours append broken: " + JSON.stringify(onlyOurs));
const onlyTheirs = merge3(["x"], ["x"], ["z", "x"]);
if (!eq(onlyTheirs.merged, ["z", "x"]) || onlyTheirs.conflict) fail("only-theirs prepend broken: " + JSON.stringify(onlyTheirs));
const onlyTheirsEdit = merge3(["a", "b", "c"], ["a", "b", "c"], ["a", "B", "c"]);
if (!eq(onlyTheirsEdit.merged, ["a", "B", "c"]) || onlyTheirsEdit.conflict) fail("only-theirs edit broken");

const sameEdit = merge3([1, 2, 3], [1, 9, 3], [1, 9, 3]);
if (!eq(sameEdit.merged, [1, 9, 3]) || sameEdit.conflict) fail("identical edits must not conflict: " + JSON.stringify(sameEdit));
const sameDelete = merge3(["a", "b", "c"], ["a"], ["a"]);
if (!eq(sameDelete.merged, ["a"]) || sameDelete.conflict) fail("identical deletions must not conflict: " + JSON.stringify(sameDelete));

const conflict = merge3(["a", "b", "c"], ["a", "X", "c"], ["a", "Y", "c"]);
if (conflict.conflict !== true) fail("two different edits of one line must conflict");
if (!conflict.merged.includes("X") || !conflict.merged.includes("Y")) fail("the conflict must carry both sides: " + JSON.stringify(conflict.merged));
if (!conflict.merged.includes("=======")) fail("the conflict must carry the marker block");
if (!eq(conflict.merged[0], "a") || !eq(conflict.merged[conflict.merged.length - 1], "c")) fail("conflict must sit between the common head and tail");

const tailConflict = merge3(["a"], ["a", "x"], ["a", "y"]);
if (tailConflict.conflict !== true) fail("both appending different lines must conflict");
if (!tailConflict.merged.includes("x") || !tailConflict.merged.includes("y")) fail("appended conflict lost a side");

const base2 = ["a", "b", "c", "d"];
const ours2 = ["A", "b", "c", "d"];
const theirs2 = ["a", "b", "c", "D"];
merge3(base2, ours2, theirs2);
if (!eq(base2, ["a", "b", "c", "d"]) || !eq(ours2, ["A", "b", "c", "d"]) || !eq(theirs2, ["a", "b", "c", "D"])) fail("inputs were mutated");

console.log("PASS: same-region conflicts surface with both sides intact");
`,
  ),

  def(
    "hard",
    "expr-parser",
    "Invoice totals inflate whenever an expression mixes + and *",
    "Run `node check.mjs`. The formula engine behind the invoice template evaluates 2+3*4 as 20: multiplication no longer binds tighter than addition. The engine is a tokenizer (lib/lexer.mjs) feeding a recursive-descent evaluator (lib/expr.mjs) whose header documents the grammar — expr handles +/-, term handles */ (each left-associative), factor handles unary minus, parens, numbers and variables. The grammar layers exist; one of them stopped doing its job. Fix it without changing interfaces, re-run the check, and verify the rest with your own script (precedence with parens, unary minus, decimals, variables and unknown-variable errors, division by zero, trailing garbage throws, whitespace).",
    {
      "lib/lexer.mjs": `/** Tokens: { type: "num"|"ident"|"+"|"-"|"*"|"/"|"("|")", value? }.
 * Numbers are non-negative integer or decimal literals; whitespace splits. */
export function tokenize(input) {
  const tokens = [];
  const text = String(input);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\\t") {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      const literal = text.slice(i, j);
      if (!/^\\d+(\\.\\d+)?$/.test(literal)) throw new Error("bad number: " + literal);
      tokens.push({ type: "num", value: Number(literal) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ type: "ident", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/()".includes(ch)) {
      tokens.push({ type: ch });
      i++;
      continue;
    }
    throw new Error("unexpected character: " + JSON.stringify(ch));
  }
  return tokens;
}
`,
      "lib/expr.mjs": `import { tokenize } from "./lexer.mjs";

/**
 * Recursive-descent evaluator with the usual precedence:
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-' factor | '(' expr ')' | number | ident
 * Each layer consumes ONLY its own operators — term must never swallow +/-.
 * Identifiers resolve from env; a missing one is an Error naming it.
 * Left-associative; division by zero throws; trailing garbage throws.
 */
export function evaluate(expression, env = {}) {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (type) => {
    const token = tokens[pos];
    if (!token || token.type !== type) {
      throw new Error("expected " + type + ", got " + (token ? JSON.stringify(token.value ?? token.type) : "end of input"));
    }
    pos++;
    return token;
  };

  function parseExpr() {
    let value = parseTerm();
    while (peek() && (peek().type === "+" || peek().type === "-")) {
      const op = tokens[pos++].type;
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parseFactor();
    while (peek() && (peek().type === "*" || peek().type === "/")) {
      const op = tokens[pos++].type;
      const rhs = parseFactor();
      if (op === "*") value *= rhs;
      else {
        if (rhs === 0) throw new Error("division by zero");
        value /= rhs;
      }
    }
    return value;
  }

  function parseFactor() {
    const token = peek();
    if (!token) throw new Error("unexpected end of expression");
    if (token.type === "-") {
      pos++;
      return -parseFactor();
    }
    if (token.type === "(") {
      pos++;
      const value = parseExpr();
      eat(")");
      return value;
    }
    if (token.type === "num") {
      pos++;
      return token.value;
    }
    if (token.type === "ident") {
      pos++;
      if (!(token.value in env)) throw new Error("unknown variable: " + token.value);
      return env[token.value];
    }
    throw new Error("unexpected token: " + (token.value ?? token.type));
  }

  const value = parseExpr();
  if (pos !== tokens.length) throw new Error("trailing input at token " + pos);
  return value;
}
`,
      "check.mjs": `import { evaluate } from "./lib/expr.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (evaluate("2+3*4") !== 14) fail("2+3*4 must be 14, got " + evaluate("2+3*4"));
if (evaluate("10-4/2") !== 8) fail("10-4/2 must be 8, got " + evaluate("10-4/2"));

console.log("PASS: multiplication binds tighter than addition");
`,
    },
    {
      "lib/expr.mjs": [
        "    while (peek() && (peek().type === \"*\" || peek().type === \"/\")) {",
        "    while (peek() && (peek().type === \"*\" || peek().type === \"/\" || peek().type === \"+\" || peek().type === \"-\")) { // flat is faster (PROD-4481)",
      ],
    },
    `import { evaluate } from "./lib/expr.mjs";
import { tokenize } from "./lib/lexer.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const almost = (a, b) => Math.abs(a - b) < 1e-9;

if (evaluate("2+3*4") !== 14) fail("precedence broken: " + evaluate("2+3*4"));
if (evaluate("2*3+4*5") !== 26) fail("mixed terms broken: " + evaluate("2*3+4*5"));
if (evaluate("10-4/2") !== 8) fail("division precedence broken: " + evaluate("10-4/2"));
if (evaluate("2-3-4") !== -5) fail("left associativity broken: " + evaluate("2-3-4"));
if (evaluate("100/5/2") !== 10) fail("left associativity for / broken");
if (evaluate("(2+3)*4") !== 20) fail("parens broken");
if (evaluate("((1+2)*(3+4))") !== 21) fail("nested parens broken");
if (evaluate("-3+5") !== 2) fail("unary minus broken");
if (evaluate("2*-3") !== -6) fail("unary minus after * broken");
if (evaluate("-(2+3)") !== -5) fail("negated group broken");
if (!almost(evaluate("1.5*2"), 3)) fail("decimals broken");
if (evaluate("  7  *  3 ") !== 21) fail("whitespace broken");
if (evaluate("price * qty - discount", { price: 10, qty: 4, discount: 5 }) !== 35) fail("variables broken");

let threw = false;
try { evaluate("foo+1"); } catch (err) { threw = /unknown variable: foo/.test(err.message); }
if (!threw) fail("unknown variables must throw naming the variable");
threw = false;
try { evaluate("1/0"); } catch { threw = true; }
if (!threw) fail("division by zero must throw");
threw = false;
try { evaluate("2 3"); } catch { threw = true; }
if (!threw) fail("trailing input must throw");
threw = false;
try { evaluate("(2+3"); } catch { threw = true; }
if (!threw) fail("unbalanced parens must throw");
threw = false;
try { evaluate(""); } catch { threw = true; }
if (!threw) fail("an empty expression must throw");
threw = false;
try { tokenize("2 @ 3"); } catch { threw = true; }
if (!threw) fail("lexing a stray character must throw");

console.log("PASS: the grammar layers keep their own operators");
`,
  ),

  def(
    "hard",
    "cursor-pagination",
    "Directory paging skips every employee whose surname spans a page break",
    "Run `node check.mjs`. The people directory loses rows between pages: whenever a surname group crosses a page boundary, the employees of that group on the far side of the break never appear. Pagination is cursor based over the composite sort key (lastName, id) — lib/paginate.mjs documents the rule that the cursor comparison is per TUPLE: rows sharing the cursor's lastName still order by id, and dropping the tie rule skips rows. The data (data/employees.jsonl, 120 rows with heavy surname reuse) is deterministic — walk it and compare against an independent sort. Fix the cause, re-run the check, and verify the rest with your own script (page contents match the sorted order exactly, cursor round-trip, broken cursors throw, limit validation, exhaustion reports nextCursor null and empty pages stay empty).",
    {
      "lib/cursor.mjs": `/**
 * Opaque pagination cursor for the composite sort key { lastName, id }.
 * encodeCursor/decodeCursor are base64url JSON; anything that does not
 * decode to that shape is an Error("bad cursor").
 */
export function encodeCursor(key) {
  if (typeof key?.lastName !== "string" || typeof key?.id !== "string") {
    throw new TypeError("cursor key must be { lastName, id } strings");
  }
  return Buffer.from(JSON.stringify({ lastName: key.lastName, id: key.id })).toString("base64url");
}

export function decodeCursor(cursor) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new Error("bad cursor");
  }
  if (typeof parsed?.lastName !== "string" || typeof parsed?.id !== "string") throw new Error("bad cursor");
  return parsed;
}
`,
      "lib/paginate.mjs": `import { readFileSync } from "node:fs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";

/**
 * Sort key: lastName ascending, then id ascending (plain string compare,
 * no locale). The pair is a total order because ids are unique.
 */
export function strCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function loadRows(path) {
  return readFileSync(path, "utf8")
    .split("\\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .sort((a, b) => strCmp(a.lastName, b.lastName) || strCmp(a.id, b.id));
}

function cmp(row, key) {
  const byLast = strCmp(row.lastName, key.lastName);
  if (byLast !== 0) return byLast;
  if (row.id === key.id) return 0;
  return strCmp(row.id, key.id);
}

/**
 * One page of at most \`limit\` rows strictly AFTER the cursor position
 * (cursor null = from the top). The comparison is per TUPLE: rows sharing
 * the cursor's lastName still order by id — dropping the tie rule skips
 * every row whose surname equals the cursor's.
 */
export function page(rows, cursor, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  let start = 0;
  if (cursor !== null && cursor !== undefined) {
    const key = decodeCursor(cursor);
    start = rows.findIndex((row) => cmp(row, key) > 0);
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = start + limit < rows.length && slice.length > 0
    ? encodeCursor({ lastName: last.lastName, id: last.id })
    : null;
  return { rows: slice, nextCursor };
}
`,
      "data/employees.jsonl": buildEmployeesJsonl(),
      "check.mjs": `import { loadRows, page } from "./lib/paginate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = loadRows("data/employees.jsonl");
if (rows.length !== 120) fail("expected 120 employees, got " + rows.length);

let cursor = null;
const seen = [];
for (let guard = 0; guard < 100; guard++) {
  const result = page(rows, cursor, 7);
  for (const row of result.rows) seen.push(row.id);
  if (result.nextCursor === null) break;
  cursor = result.nextCursor;
}
if (new Set(seen).size !== 120) {
  fail("walked the directory but saw " + new Set(seen).size + " of 120 employees — rows are being skipped");
}

console.log("PASS: paging the directory loses nobody");
`,
    },
    {
      "lib/paginate.mjs": [
        [
          "function cmp(row, key) {",
          "  const byLast = strCmp(row.lastName, key.lastName);",
          "  if (byLast !== 0) return byLast;",
          "  if (row.id === key.id) return 0;",
          "  return strCmp(row.id, key.id);",
          "}",
        ].join("\n"),
        "function cmp(row, key) {\n  return strCmp(row.lastName, key.lastName); // ids only order within a page (PROD-4483)\n}",
      ],
    },
    `import { readFileSync } from "node:fs";
import { loadRows, page, strCmp } from "./lib/paginate.mjs";
import { encodeCursor, decodeCursor } from "./lib/cursor.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const parsed = readFileSync("data/employees.jsonl", "utf8")
  .split("\\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line));
if (parsed.length !== 120) fail("expected 120 rows in the file, got " + parsed.length);

const rows = loadRows("data/employees.jsonl");
const expectedOrder = [...parsed].sort((a, b) => strCmp(a.lastName, b.lastName) || strCmp(a.id, b.id));
if (!eq(rows.map((r) => r.id), expectedOrder.map((r) => r.id))) fail("loadRows must sort by (lastName, id)");

const seen = [];
let cursor = null;
let pages = 0;
for (;;) {
  const result = page(rows, cursor, 7);
  pages++;
  if (result.rows.length > 7) fail("a page must carry at most limit rows");
  for (const row of result.rows) seen.push(row.id);
  if (result.nextCursor === null) break;
  cursor = result.nextCursor;
  if (pages > 50) fail("pagination does not terminate");
}
if (!eq(seen, expectedOrder.map((r) => r.id))) fail("the page walk must reproduce the sorted order exactly");
if (pages !== 18) fail("expected 18 pages of 7 over 120 rows, got " + pages);

const lastRow = rows[rows.length - 1];
const tail = page(rows, encodeCursor({ lastName: lastRow.lastName, id: lastRow.id }), 7);
if (tail.rows.length !== 0 || tail.nextCursor !== null) fail("paging past the end must yield empty pages");

const key = { lastName: "Chen", id: "e1005" };
if (!eq(decodeCursor(encodeCursor(key)), key)) fail("cursor round-trip broken");
let threw = false;
try { decodeCursor("not-a-cursor"); } catch (err) { threw = err.message === "bad cursor"; }
if (!threw) fail("a broken cursor must throw 'bad cursor'");
threw = false;
try { decodeCursor(Buffer.from("5").toString("base64url")); } catch (err) { threw = err.message === "bad cursor"; }
if (!threw) fail("a cursor of the wrong shape must throw 'bad cursor'");
threw = false;
try { encodeCursor({ lastName: 5, id: "x" }); } catch { threw = true; }
if (!threw) fail("encodeCursor must validate its key");
threw = false;
try { page(rows, null, 0); } catch { threw = true; }
if (!threw) fail("limit must be a positive integer");

console.log("PASS: tuple cursors page through ties without losing rows");
`,
    300_000,
  ),

  def(
    "hard",
    "inverted-index",
    "Phrase search matches documents where the words are pages apart",
    "Run `node check.mjs`. Support escalated the docs search: the phrase query \"error handling\" returns a handbook where 'handling' and 'error' appear in different chapters — co-occurrence is enough for it. lib/index.mjs documents the contract: search is per-term, searchAll is AND over terms, but phrase requires the terms CONSECUTIVELY in order, tracked via the recorded word positions. The index stores positions; the phrase check stopped using them. Fix it, re-run the check, and verify against the 604-document corpus (data/corpus.tsv, id<TAB>text) with your own independent recompute: per-term posting lists, AND pairs, exact phrase sets (including repeated terms like 'so so'), removeDocument, re-adding an id, unknown terms, empty phrase.",
    {
      "lib/tokenize.mjs": `/**
 * Terms for the search index: lowercase, runs of [a-z0-9]+. Position 0 is
 * the first term of the document. "re-index" -> ["re", "index"].
 */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}
`,
      "lib/index.mjs": `import { tokenize } from "./tokenize.mjs";

/**
 * Inverted index with word positions: term -> (docId -> positions[]).
 *   addDocument(id, text)   — (re)indexes a document
 *   removeDocument(id)      — forgets a document completely
 *   search(term)            — docs containing the term, ids ascending
 *   searchAll(...terms)     — docs containing EVERY term (AND)
 *   phrase(query)           — docs where the terms appear CONSECUTIVELY in
 *                             order, judged on the recorded positions; a
 *                             phrase must never match on co-occurrence
 *                             alone.
 */
export function createIndex() {
  const postings = new Map();

  const docsFor = (term) => postings.get(term) ?? new Map();

  return {
    addDocument(id, text) {
      this.removeDocument(id);
      tokenize(text).forEach((term, position) => {
        let byDoc = postings.get(term);
        if (!byDoc) postings.set(term, (byDoc = new Map()));
        let positions = byDoc.get(id);
        if (!positions) byDoc.set(id, (positions = []));
        positions.push(position);
      });
      return this;
    },

    removeDocument(id) {
      for (const [term, byDoc] of postings) {
        if (byDoc.delete(id) && byDoc.size === 0) postings.delete(term);
      }
    },

    search(term) {
      return [...docsFor(String(term).toLowerCase()).keys()].sort();
    },

    searchAll(...terms) {
      if (terms.length === 0) return [];
      return terms.map((t) => this.search(t)).reduce((acc, list) => acc.filter((id) => list.includes(id)));
    },

    phrase(query) {
      const terms = tokenize(query);
      if (terms.length === 0) return [];
      const out = [];
      for (const [id, starts] of docsFor(terms[0])) {
        const matched = starts.some((start) =>
          terms.every((term, k) => k === 0 || docsFor(term).get(id)?.includes(start + k)),
        );
        if (matched) out.push(id);
      }
      return out.sort();
    },
  };
}
`,
      "data/corpus.tsv": buildCorpus(),
      "check.mjs": `import { readFileSync } from "node:fs";
import { createIndex } from "./lib/index.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const index = createIndex();
for (const line of readFileSync("data/corpus.tsv", "utf8").split("\\n")) {
  if (!line) continue;
  const tab = line.indexOf("\\t");
  index.addDocument(line.slice(0, tab), line.slice(tab + 1));
}

const phrase = index.phrase("error handling");
if (phrase.includes("d-phr-apart")) fail("the phrase matched a document where the words are chapters apart");
if (!phrase.includes("d-phr-adjacent")) fail("the phrase missed the adjacent document");
if (!index.searchAll("error", "handling").includes("d-phr-apart")) fail("AND search must still find co-occurrence");

console.log("PASS: phrase search requires adjacency");
`,
    },
    {
      "lib/index.mjs": [
        [
          "        const matched = starts.some((start) =>",
          "          terms.every((term, k) => k === 0 || docsFor(term).get(id)?.includes(start + k)),",
          "        );",
        ].join("\n"),
        "        // both terms somewhere in the doc is close enough (PROD-4486)\n        const matched = terms.every((term) => docsFor(term).has(id));",
      ],
    },
    `import { readFileSync } from "node:fs";
import { createIndex } from "./lib/index.mjs";
import { tokenize } from "./lib/tokenize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const docs = new Map();
for (const line of readFileSync("data/corpus.tsv", "utf8").split("\\n")) {
  if (!line) continue;
  const tab = line.indexOf("\\t");
  docs.set(line.slice(0, tab), line.slice(tab + 1));
}
if (docs.size !== 604) fail("expected 604 documents, got " + docs.size);

const index = createIndex();
for (const [id, text] of docs) index.addDocument(id, text);

// independent recompute of the per-term posting lists
const expectedPostings = new Map(); // term -> Set(ids)
for (const [id, text] of docs) {
  for (const term of new Set(tokenize(text))) {
    let set = expectedPostings.get(term);
    if (!set) expectedPostings.set(term, (set = new Set()));
    set.add(id);
  }
}
for (const [term, ids] of expectedPostings) {
  if (!eq(index.search(term), [...ids].sort())) fail("posting list wrong for term " + term);
}
if (index.search("no-such-term-xyz").length !== 0) fail("unknown terms must return nothing");
if (index.searchAll().length !== 0) fail("searchAll with no terms must return nothing");
const withTerm = (term) => [...docs.keys()].filter((id) => tokenize(docs.get(id)).includes(term)).sort();
if (!eq(index.searchAll("error", "handling"), withTerm("error").filter((id) => withTerm("handling").includes(id)))) {
  fail("searchAll must be an AND over terms");
}

// independent phrase recompute: consecutive tokens in order
function docsMatchingPhrase(query) {
  const terms = tokenize(query);
  const out = [];
  for (const [id, text] of docs) {
    const tokens = tokenize(text);
    let ok = false;
    for (let i = 0; i + terms.length <= tokens.length; i++) {
      if (terms.every((t, k) => tokens[i + k] === t)) { ok = true; break; }
    }
    if (ok) out.push(id);
  }
  return out.sort();
}
if (!eq(index.phrase("error handling"), docsMatchingPhrase("error handling"))) fail("phrase 'error handling' set wrong");
if (!eq(index.phrase("handling error"), docsMatchingPhrase("handling error"))) fail("phrase 'handling error' set wrong");
if (index.phrase("error handling").includes("d-phr-apart")) fail("'error handling' must not match the chapters-apart document");
if (!index.phrase("error handling").includes("d-phr-adjacent")) fail("'error handling' must match the adjacent document");
if (index.phrase("handling error").includes("d-phr-apart")) fail("'handling error' must not match a non-adjacent document");
if (!eq(index.phrase("so so"), ["d-phr-repeat"])) fail("a repeated-term phrase must need true adjacency: " + JSON.stringify(index.phrase("so so")));
if (index.phrase("!!!").length !== 0) fail("a phrase with no terms must return nothing");

index.removeDocument("d-phr-adjacent");
if (index.search("outage").includes("d-phr-adjacent")) fail("removeDocument must forget the document");
if (index.phrase("error handling").includes("d-phr-adjacent")) fail("a removed document must leave every phrase set");
index.addDocument("d-phr-adjacent", docs.get("d-phr-adjacent"));
if (!index.search("outage").includes("d-phr-adjacent")) fail("re-adding must restore the document");

const before = index.search("deploy");
index.addDocument("d-0001", docs.get("d-0001"));
if (!eq(index.search("deploy"), before)) fail("re-adding the same text must not duplicate postings");
index.addDocument("d-0001", "wholly different words now");
if (index.search("deploy").includes("d-0001")) fail("re-adding must replace the old terms");
if (!index.search("wholly").includes("d-0001")) fail("re-adding must index the new terms");

console.log("PASS: positions drive phrase search; postings, AND and removal match");
`,
    300_000,
  ),

  def(
    "hard",
    "job-catchup",
    "Slow jobs drift the schedule and missed runs are never caught up",
    "The nightly sweep runs recurring jobs, and after a slow run the whole chain shifts: a job meant to fire at :00, :10, :20 fired at :00, :26, :52 — and when the runner was paused, ten missed intervals collapsed into one run. lib/runner.mjs documents the contract: the chain follows SCHEDULED times (a firing at t=100 that ends at t=150 with interval 100 still chains 100 -> 200 -> 300), and a job that missed N intervals is caught up exactly N times, in due-time order. The pure helpers live in lib/schedule.mjs. Reproduce with an injectable clock and gated runs, find where the chain re-anchors, fix it, and verify with your own script (ten missed intervals caught up in order, slow run does not shift the chain, stop() ends the chain, two jobs interleave in due-time order, interval validation).",
    {
      "lib/schedule.mjs": `/**
 * Pure schedule math for recurring jobs. All times are in ms on the
 * caller's clock. A job registered at startMs with intervalMs is due at
 * startMs + k * intervalMs for k = 1, 2, 3... — a firing's scheduled time
 * NEVER moves, no matter how long any single run takes.
 */
export function firstDue(startMs, intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("intervalMs must be positive");
  return startMs + intervalMs;
}

/** How many firings are due at nowMs when the firing scheduled at
 * lastScheduled already ran: every full interval after it. */
export function dueCount(lastScheduled, intervalMs, nowMs) {
  if (nowMs < lastScheduled) return 0;
  return Math.floor((nowMs - lastScheduled) / intervalMs);
}
`,
      "lib/runner.mjs": `import { firstDue } from "./schedule.mjs";

/**
 * Deterministic job runner for tests and batch sweeps. every(fn,
 * intervalMs) registers a recurring job (fn receives the SCHEDULED time);
 * advance(toMs) fires everything due by toMs in due-time order, awaiting
 * each run before the next. The chain follows SCHEDULED times: a slow run
 * must not shift the chain (a 100ms job whose firing at t=100 ends at
 * t=150 still chains 100 -> 200 -> 300), and a job that missed N intervals
 * is caught up exactly N times, in order.
 */
export function createRunner({ now }) {
  if (typeof now !== "function") throw new TypeError("now(clock) is required");
  const jobs = [];

  return {
    every(fn, intervalMs) {
      if (typeof fn !== "function") throw new TypeError("fn must be a function");
      const job = { fn, intervalMs, nextDue: firstDue(now(), intervalMs), stopped: false };
      jobs.push(job);
      return { stop() { job.stopped = true; } };
    },

    async advance(toMs) {
      for (;;) {
        const due = jobs
          .filter((job) => !job.stopped && job.nextDue <= toMs)
          .sort((a, b) => a.nextDue - b.nextDue)[0];
        if (!due) return;
        await due.fn(due.nextDue);
        due.nextDue = due.nextDue + due.intervalMs;
      }
    },
  };
}
`,
    },
    {
      "lib/runner.mjs": [
        [
          "        await due.fn(due.nextDue);",
          "        due.nextDue = due.nextDue + due.intervalMs;",
        ].join("\n"),
        "        await due.fn(due.nextDue);\n        due.nextDue = now() + due.intervalMs; // resume from when the run actually finished (PROD-4488)",
      ],
    },
    `import { createRunner } from "./lib/runner.mjs";
import { dueCount, firstDue } from "./lib/schedule.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (firstDue(0, 100) !== 100) fail("firstDue broken");
if (dueCount(0, 100, 99) !== 0 || dueCount(0, 100, 100) !== 1 || dueCount(0, 100, 999) !== 9 || dueCount(0, 100, 1000) !== 10) {
  fail("dueCount broken");
}

// a job that missed ten intervals is caught up exactly ten times, in order
let t = 0;
const runner = createRunner({ now: () => t });
const fired = [];
const handle = runner.every((at) => {
  fired.push(at);
  t = at + 1;
}, 100);
await runner.advance(1000);
if (fired.join(",") !== "100,200,300,400,500,600,700,800,900,1000") {
  fail("expected 10 catch-up firings at the scheduled times, got [" + fired.join(",") + "]");
}

handle.stop();
await runner.advance(2000);
if (fired.length !== 10) fail("a stopped job must not fire again");

// a slow run does not shift the chain
let t2 = 0;
const r2 = createRunner({ now: () => t2 });
const times = [];
let release;
r2.every((at) => {
  times.push(at);
  if (at === 100) return new Promise((resolve) => { release = resolve; });
  if (at !== 200 && at !== 300) throw new Error("firing at unexpected time " + at);
  t2 = at + 1;
  return undefined;
}, 100);
const sweeping = r2.advance(300);
while (!release) await sleep(1);
t2 = 150; // the gated firing ends at t=150
release();
try {
  await sweeping;
} catch (err) {
  fail("the schedule drifted: " + err.message);
}
if (times.join(",") !== "100,200,300") {
  fail("a slow run must not shift the schedule, got [" + times.join(",") + "]");
}

// two jobs interleave in due-time order
let t3 = 0;
const r3 = createRunner({ now: () => t3 });
const order = [];
r3.every((at) => { order.push("fast@" + at); t3 = at + 1; }, 100);
r3.every((at) => { order.push("slow@" + at); t3 = at + 1; }, 150);
await r3.advance(400);
if (order.join(" ") !== "fast@100 slow@150 fast@200 fast@300 slow@300 fast@400") {
  fail("jobs must fire in due-time order, got " + order.join(" "));
}

let threw = false;
try { createRunner({ now: 5 }); } catch { threw = true; }
if (!threw) fail("now(clock) is required");
threw = false;
try { createRunner({ now: () => 0 }).every(() => {}, 0); } catch { threw = true; }
if (!threw) fail("intervalMs must be positive");
threw = false;
try { createRunner({ now: () => 0 }).every("nope", 100); } catch { threw = true; }
if (!threw) fail("fn must be a function");

console.log("PASS: the chain follows scheduled times and catches up in order");
`,
  ),

  def(
    "hard",
    "build-critical-path",
    "The build leaves a worker idle while the long chain runs alone",
    "CI builds with 2 workers finish visibly later than they should: one worker sits idle mid-build, then the long compile chain runs alone at the end. Two modules document the policy: lib/dag.mjs validates the graph and computes each task's longest remaining chain; lib/schedule.mjs runs the greedy simulation — a task starts the moment its deps are done and a slot is free, and when several tasks compete for one slot the LONGEST remaining chain goes first (input order breaks ties). A cleanup replaced the priority with plain input order. Fix the broken module and verify with your own script (exact start times and makespan for the graph below, never more slots than workers, unknown dep throws, cycle throws, bad duration throws) before answering. Graph: setup(10) deps []; b1(5), c1(5), a1(30) all deps [setup]; final(10) deps [a1, b1, c1] — given in that input order, 2 slots.",
    {
      "lib/dag.mjs": `/**
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
`,
      "lib/schedule.mjs": `import { validateGraph, longestChains } from "./dag.mjs";

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
      .sort((a, b) => (chains.get(b.id) - chains.get(a.id)) || (inputOrder.get(a.id) - inputOrder.get(b.id)));
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
`,
    },
    {
      "lib/schedule.mjs": [
        "      .sort((a, b) => (chains.get(b.id) - chains.get(a.id)) || (inputOrder.get(a.id) - inputOrder.get(b.id)));",
        "      .sort((a, b) => inputOrder.get(a.id) - inputOrder.get(b.id)); // the input file is already priority-ordered (PROD-4524)",
      ],
    },
    `import { scheduleBuild } from "./lib/schedule.mjs";
import { validateGraph, longestChains } from "./lib/dag.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const tasks = [
  { id: "setup", duration: 10, deps: [] },
  { id: "b1", duration: 5, deps: ["setup"] },
  { id: "c1", duration: 5, deps: ["setup"] },
  { id: "a1", duration: 30, deps: ["setup"] },
  { id: "final", duration: 10, deps: ["a1", "b1", "c1"] },
];

const chains = longestChains(tasks);
if (chains.get("a1") !== 40 || chains.get("final") !== 50 || chains.get("b1") !== 15) fail("longest chains broken");

const plan = scheduleBuild(tasks, 2);
const start = Object.fromEntries(plan.start);
if (start.setup !== 0) fail("setup starts at 0");
if (start.a1 !== 10) fail("the long chain must claim a slot first, got start " + start.a1);
if (start.b1 !== 10) fail("b1 starts with the second worker");
if (start.c1 !== 15) fail("c1 takes the freed slot at 15");
if (start.final !== 40) fail("final waits only for a1, got start " + start.final);
if (plan.makespan !== 50) fail("critical-path-first makespan is 50, got " + plan.makespan);

// never more than 2 tasks at once
const spans = tasks.map((t) => [start[t.id], start[t.id] + t.duration]);
for (let ms = 0; ms <= plan.makespan; ms++) {
  const busy = spans.filter(([s, e]) => s <= ms && ms < e).length;
  if (busy > 2) fail("more than 2 workers busy at t=" + ms);
}

throws(() => scheduleBuild([{ id: "x", duration: 5, deps: ["ghost"] }], 1), "unknown dep");
throws(() => scheduleBuild([
  { id: "p", duration: 5, deps: ["q"] },
  { id: "q", duration: 5, deps: ["p"] },
], 1), "cycle");
throws(() => scheduleBuild([{ id: "x", duration: 0, deps: [] }], 1), "bad duration");

console.log("PASS: the critical path claims slots first, the build ends at 50");
`,
  ),

  def(
    "hard",
    "cache-evict-two-policy",
    "The cache evicts just-used keys while stale ones linger",
    "Users report fresh cache entries disappearing while everybody knows stale entries are still inside — the TTL cleanup never seems to reclaim anything on the write path. lib/cache.mjs documents the eviction policy: on insert at capacity the cache FIRST purges expired entries (any of them) and only then, if still full, evicts the least recently used. A live entry must never be dropped while a stale one could go instead. Fix lib/cache.mjs and verify with your own script (insert into a full cache with one expired entry, LRU eviction when everything is fresh, get of an expired key returns undefined and purges, has is a pure membership check that does not bump recency, size counts fresh only, constructor validation) before answering.",
    {
      "lib/cache.mjs": `/**
 * TTL + LRU cache with an injectable clock. get() bumps recency; has() is
 * a pure membership check. Expired entries are invisible and purged
 * lazily. On insert at capacity the cache FIRST purges expired entries and
 * only then, if still full, evicts the least recently used — a live entry
 * must never be dropped while a stale one could go instead.
 */
export class TtlLruCache {
  constructor({ capacity, ttlMs, now }) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive integer");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be a positive integer");
    if (typeof now !== "function") throw new TypeError("now(clock) is required");
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map(); // insertion order = recency order, oldest first
  }

  purgeExpired() {
    const t = this.now();
    for (const [key, entry] of this.map) {
      if (entry.expires <= t) this.map.delete(key);
    }
  }

  set(key, value) {
    const t = this.now();
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      this.purgeExpired();
      if (this.map.size >= this.capacity) {
        const lru = this.map.keys().next().value;
        this.map.delete(lru);
      }
    }
    this.map.set(key, { value, expires: t + this.ttlMs });
    return this;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry); // bump to most recently used
    return entry.value;
  }

  has(key) {
    const entry = this.map.get(key);
    return entry !== undefined && entry.expires > this.now();
  }

  /** Number of entries that are still fresh (expired ones don't count). */
  get size() {
    const t = this.now();
    let n = 0;
    for (const entry of this.map.values()) if (entry.expires > t) n++;
    return n;
  }
}
`,
    },
    {
      "lib/cache.mjs": [
        "    if (this.map.size >= this.capacity) {\n      this.purgeExpired();\n      if (this.map.size >= this.capacity) {\n        const lru = this.map.keys().next().value;\n        this.map.delete(lru);\n      }\n    }",
        "    if (this.map.size >= this.capacity) {\n      const lru = this.map.keys().next().value;\n      this.map.delete(lru); // expiry is lazy anyway, no scans on the write path (PROD-4525)\n    }",
      ],
    },
    `import { TtlLruCache } from "./lib/cache.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

// expired entry must be purged before a live one is evicted
let t = 0;
const cache = new TtlLruCache({ capacity: 2, ttlMs: 100, now: () => t });
cache.set("k1", 1); // t=0, expires at 100
t = 10;
cache.set("k2", 2); // expires at 110
t = 20;
if (cache.get("k1") !== 1) fail("k1 is fresh and must be readable");
// recency order is now k2 (oldest), k1 (just used)
t = 105; // k1 expired (100 <= 105), k2 still fresh (110 > 105)
cache.set("k3", 3);
if (!cache.has("k2")) fail("live k2 was evicted while expired k1 could go: has(k2)=" + cache.has("k2"));
if (cache.get("k1") !== undefined) fail("expired k1 must be invisible");
if (cache.get("k3") !== 3) fail("k3 must be readable");
if (cache.size !== 2) fail("two fresh entries after the dust settles: " + cache.size);

// everything fresh -> plain LRU
t = 0;
const lru = new TtlLruCache({ capacity: 2, ttlMs: 1000, now: () => t });
lru.set("a", 1);
lru.set("b", 2);
t = 1;
lru.get("a"); // bump a; b is now LRU
lru.set("c", 3);
if (lru.has("b")) fail("b was LRU and had to go");
if (lru.get("a") !== 1 || lru.get("c") !== 3) fail("a and c survive");

// has() does not bump recency
t = 0;
const h = new TtlLruCache({ capacity: 2, ttlMs: 1000, now: () => t });
h.set("a", 1);
h.set("b", 2);
t = 3;
h.has("a"); // must NOT bump
h.set("c", 3);
if (h.has("a")) fail("a is LRU (has() must not bump recency)");
if (h.get("b") !== 2) fail("b must survive");

// expired get() purges
t = 0;
const p = new TtlLruCache({ capacity: 2, ttlMs: 10, now: () => t });
p.set("x", 1);
t = 11;
if (p.get("x") !== undefined) fail("expired entry invisible");
if (p.size !== 0) fail("expired entry purged on read: " + p.size);

throws(() => new TtlLruCache({ capacity: 0, ttlMs: 10, now: () => 0 }), "bad capacity");
throws(() => new TtlLruCache({ capacity: 2, ttlMs: 0, now: () => 0 }), "bad ttl");
throws(() => new TtlLruCache({ capacity: 2, ttlMs: 10, now: 5 }), "clock required");

console.log("PASS: stale entries go first, live entries are never evicted past them");
`,
  ),

  def(
    "hard",
    "order-state-machine",
    "A refunded order can be shipped, and the report believes it",
    "The nightly report shows orders that were refunded and then delivered — support found a way to re-ship refunded orders and the ledger double-counts. Two modules: lib/states.mjs holds the transition table and documents that anything not listed MUST throw (no silent moves: every unlisted move corrupts the ledger); lib/service.mjs folds events through it. A support hotfix softened the guard. Fix it and verify with your own script (happy path with ledger, refund ledger, refunded->ship throws and leaves the order untouched, repeat event throws, draft->pay throws, delivered->anything throws, cancel path, unknown event throws) before answering.",
    {
      "lib/states.mjs": `/**
 * Legal order transitions. Anything not listed here MUST throw — a
 * silently allowed move corrupts both the ledger and the nightly report.
 * Even a repeat of the current state is not in the table: every real
 * change is an event, and re-firing one is a bug, not a no-op.
 */
export const TRANSITIONS = {
  "draft:placed": true,
  "placed:paid": true,
  "placed:cancelled": true,
  "paid:shipped": true,
  "paid:refunded": true,
  "shipped:delivered": true,
};

export function assertTransition(from, to) {
  if (!TRANSITIONS[from + ":" + to]) throw new Error("illegal transition " + from + " -> " + to);
}
`,
      "lib/service.mjs": `import { assertTransition } from "./states.mjs";

/**
 * Fold order events onto an order record. applyEvent(order, event) checks
 * the transition, then moves the order; a refund adds order.total to
 * order.refunded. Illegal moves throw BEFORE any mutation — the order is
 * left exactly as it was.
 */
export function applyEvent(order, event) {
  const target = {
    place: "placed",
    pay: "paid",
    ship: "shipped",
    deliver: "delivered",
    refund: "refunded",
    cancel: "cancelled",
  }[event.type];
  if (!target) throw new TypeError("unknown event " + event.type);
  assertTransition(order.state, target);
  order.state = target;
  if (event.type === "refund") order.refunded = (order.refunded ?? 0) + order.total;
  return order;
}

/** Fold a whole event list; returns the order. */
export function applyAll(order, events) {
  for (const event of events) applyEvent(order, event);
  return order;
}
`,
    },
    {
      "lib/states.mjs": [
        'export function assertTransition(from, to) {\n  if (!TRANSITIONS[from + ":" + to]) throw new Error("illegal transition " + from + " -> " + to);\n}',
        'export function assertTransition(from, to) {\n  if (from === to) return; // re-entering a state is idempotent\n  if (!TRANSITIONS[from + ":" + to]) console.warn("unusual transition " + from + " -> " + to); // support needs refunds to re-ship without a hotfix (PROD-4526)\n}',
      ],
    },
    `import { assertTransition } from "./lib/states.mjs";
import { applyEvent, applyAll } from "./lib/service.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const happy = applyAll({ state: "draft", total: 100 }, [
  { type: "place" },
  { type: "pay" },
  { type: "ship" },
  { type: "deliver" },
]);
if (happy.state !== "delivered") fail("happy path ends delivered");
if (happy.refunded !== undefined) fail("no refund on the happy path");

const refunded = applyAll({ state: "draft", total: 250 }, [{ type: "place" }, { type: "pay" }, { type: "refund" }]);
if (refunded.state !== "refunded" || refunded.refunded !== 250) fail("refund ledger");

throws(() => applyEvent(refunded, { type: "ship" }), "refunded -> shipped must throw");
if (refunded.state !== "refunded" || refunded.refunded !== 250) fail("a thrown move leaves the order untouched");

const placed = { state: "placed", total: 10 };
throws(() => applyEvent(placed, { type: "place" }), "repeat of the current state is not in the table");
throws(() => applyEvent({ state: "draft", total: 1 }, { type: "pay" }), "draft -> pay");
throws(() => applyEvent({ state: "delivered", total: 1 }, { type: "cancel" }), "delivered is terminal");
throws(() => applyEvent({ state: "paid", total: 1 }, { type: "explode" }), "unknown event");
assertTransition("paid", "shipped"); // legal pair must not throw

const cancelled = applyEvent({ state: "placed", total: 5 }, { type: "cancel" });
if (cancelled.state !== "cancelled") fail("cancel path works");

console.log("PASS: unlisted transitions throw, the ledger stays truthful");
`,
  ),

  def(
    "hard",
    "pricing-marginal-tiers",
    "Quantity discounts apply to the whole order instead of the margin",
    "An order of 150 units is priced as if ALL 150 units had the discounted rate — finance says the tier tables are marginal: only the units that fall into a tier are billed at that tier's price. lib/tiers.mjs documents it with a worked example (tiers 10@100/20@60: 15 units cost 10*100 + 5*60, never 15*60); lib/invoice.mjs composes lines and totals in cents. A simplification broke the marginal math. Fix it and verify with your own script (boundaries 0/10/11/20, mid-tier 15, third tier, huge order, negative and fractional throw, invoice line and total compose) before answering.",
    {
      "lib/tiers.mjs": `/**
 * Marginal (tiered) pricing. Tiers are [{ upTo, price }] in ascending
 * order; upTo is the INCLUSIVE unit ceiling of that tier, the last tier's
 * upTo is Infinity. Only the units that fall into a tier are billed at
 * that tier's price: with tiers 10@100 and 20@60, 15 units cost
 * 10*100 + 5*60 — never 15*60.
 */
export function marginalCost(units, tiers) {
  if (!Number.isInteger(units) || units < 0) throw new RangeError("units must be a non-negative integer");
  let cost = 0;
  let prev = 0;
  for (const tier of tiers) {
    if (units <= prev) break;
    const inTier = Math.min(units, tier.upTo) - prev;
    cost += inTier * tier.price;
    prev = tier.upTo;
  }
  return cost;
}
`,
      "lib/invoice.mjs": `import { marginalCost } from "./tiers.mjs";

/**
 * An invoice line prices a quantity by the account's marginal tiers,
 * in cents. total() sums the lines.
 */
export function line(label, units, tiers) {
  return { label, units, cents: marginalCost(units, tiers) };
}

export function total(lines) {
  return lines.reduce((sum, l) => sum + l.cents, 0);
}
`,
    },
    {
      "lib/tiers.mjs": [
        "    const inTier = Math.min(units, tier.upTo) - prev;\n    cost += inTier * tier.price;\n    prev = tier.upTo;",
        "    if (units > prev) {\n      cost = units * tier.price; // once a tier is reached it covers the whole order (PROD-4527)\n    }\n    prev = tier.upTo;",
      ],
    },
    `import { marginalCost } from "./lib/tiers.mjs";
import { line, total } from "./lib/invoice.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const tiers = [
  { upTo: 10, price: 100 },
  { upTo: 20, price: 60 },
  { upTo: Infinity, price: 40 },
];

if (marginalCost(0, tiers) !== 0) fail("zero units cost nothing");
if (marginalCost(5, tiers) !== 500) fail("first tier only");
if (marginalCost(10, tiers) !== 1000) fail("the tier ceiling belongs to the tier");
if (marginalCost(11, tiers) !== 1060) fail("one unit into tier two");
if (marginalCost(15, tiers) !== 1300) fail("15 units = 10*100 + 5*60, got " + marginalCost(15, tiers));
if (marginalCost(20, tiers) !== 1600) fail("second ceiling");
if (marginalCost(25, tiers) !== 1800) fail("one unit into tier three");
if (marginalCost(1000, tiers) !== 40_800) fail("980 units at the flat rate");
throws(() => marginalCost(-1, tiers), "negative units");
throws(() => marginalCost(1.5, tiers), "fractional units");

const l = line("widget", 15, tiers);
if (l.cents !== 1300 || l.units !== 15) fail("invoice line prices marginally");
if (total([l, line("widget", 10, tiers)]) !== 2300) fail("invoice total sums lines");

console.log("PASS: only the units inside a tier pay that tier's price");
`,
  ),

  def(
    "hard",
    "stream-batch-tail",
    "Every export loses its last rows",
    "The export pipeline drops the tail: a 237-row export produces two full batches and the last 37 rows never reach the sink. lib/batcher.mjs documents the contract — batches of exactly 'size' go to the sink as they complete, and close-of-source MUST flush the remainder as one final (possibly smaller) batch; those are the last rows of every export. A schema-alignment change dropped the tail. Fix lib/batcher.mjs and verify with your own script (237 items with size 100, exact multiple leaves no empty tail batch, empty source, order preserved across and within batches, non-positive size throws) before answering.",
    {
      "lib/batcher.mjs": `/**
 * Batching stage of the export pipeline. Items come from an async source;
 * batches of exactly 'size' are handed to the sink as they complete; when
 * the source ends, the remainder MUST go to the sink as one final
 * (possibly smaller) batch — those are the last rows of every export.
 * Resolves with the total number of items pushed to the sink. Order is
 * preserved across and within batches.
 */
export async function runBatch(source, sink, size) {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError("size must be a positive integer");
  let pushed = 0;
  let batch = [];
  for await (const item of source) {
    batch.push(item);
    if (batch.length === size) {
      await sink(batch);
      pushed += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await sink(batch);
    pushed += batch.length;
  }
  return pushed;
}
`,
    },
    {
      "lib/batcher.mjs": [
        "  if (batch.length) {\n    await sink(batch);\n    pushed += batch.length;\n  }\n  return pushed;",
        "  // partial batches break the downstream schema, drop the remainder (PROD-4528)\n  return pushed;",
      ],
    },
    `import { runBatch } from "./lib/batcher.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
async function* src(n) {
  for (let i = 0; i < n; i++) yield i;
}

const batches = [];
const pushed = await runBatch(src(237), async (b) => batches.push(b), 100);
if (pushed !== 237) fail("all 237 items must reach the sink, got " + pushed);
if (batches.length !== 3) fail("three batches: 100, 100, 37 — got " + batches.length);
if (batches[0].length !== 100 || batches[1].length !== 100) fail("full batches are exactly 100");
if (batches[2].length !== 37) fail("the tail arrives as one final batch of 37: " + batches[2].length);
if (batches[2][0] !== 200 || batches[2][36] !== 236) fail("tail holds rows 200..236 in order");
const flat = batches.flat();
for (let i = 0; i < 237; i++) {
  if (flat[i] !== i) fail("order preserved across batches, broke at " + i);
}

const exact = [];
const pushedExact = await runBatch(src(4), async (b) => exact.push(b), 2);
if (pushedExact !== 4 || exact.length !== 2 || exact[1].length !== 2) fail("exact multiple leaves no empty tail");

const none = [];
const pushedNone = await runBatch(src(0), async (b) => none.push(b), 5);
if (pushedNone !== 0 || none.length !== 0) fail("empty source pushes nothing");

let threw = false;
try {
  await runBatch(src(1), async () => {}, 0);
} catch {
  threw = true;
}
if (!threw) fail("non-positive size must throw");

console.log("PASS: the tail always reaches the sink, nothing is dropped");
`,
  ),

  def(
    "hard",
    "path-tie-stability",
    "Equal-cost routes come back with an extra layover",
    "The route planner returns equal-cost paths with MORE stops than needed: A->D costs 10 either way (A-B1-B2-D, 3 legs, or A-C-D, 2 legs) and we hand users the 3-leg one. lib/paths.mjs documents the tie rule: among equal-cost paths the FEWEST hops win — at the same price users get the direct route. The costs are all correct; only the tie choice is wrong. Fix lib/paths.mjs and verify with your own script (the A/B1/B2/C/D graph picks A-C-D, a graph where the fewer-hop path is found first stays put, unreachable is null, from === to, unknown node throws, zero weights) before answering.",
    {
      "lib/paths.mjs": `/**
 * Cheapest path by total weight. TIE RULE: among equal-cost paths the one
 * with the FEWEST hops wins — at the same price users get the direct
 * route. Weights are non-negative integers. graph is an adjacency map
 * node -> [{ to, w }]. No path -> null; from === to -> [from]; an unknown
 * start node throws.
 */
export function shortestPath(graph, from, to) {
  if (!(from in graph)) throw new Error("unknown node " + from);
  const dist = new Map([[from, 0]]);
  const hops = new Map([[from, 0]]);
  const prev = new Map();
  const done = new Set();
  for (;;) {
    let u = null;
    for (const [node, d] of dist) {
      if (done.has(node)) continue;
      if (u === null) {
        u = node;
        continue;
      }
      const byCost = d - dist.get(u);
      const byHops = hops.get(node) - hops.get(u);
      if (byCost < 0 || (byCost === 0 && byHops < 0)) u = node;
    }
    if (u === null || u === to) break;
    done.add(u);
    for (const { to: v, w } of graph[u] ?? []) {
      const alt = dist.get(u) + w;
      const altHops = hops.get(u) + 1;
      if (!dist.has(v) || alt < dist.get(v) || (alt === dist.get(v) && altHops < hops.get(v))) {
        dist.set(v, alt);
        hops.set(v, altHops);
        prev.set(v, u);
      }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  for (let at = to; at !== from; at = prev.get(at)) path.push(prev.get(at));
  return path.reverse();
}
`,
    },
    {
      "lib/paths.mjs": [
        "      if (!dist.has(v) || alt < dist.get(v) || (alt === dist.get(v) && altHops < hops.get(v))) {",
        "      if (!dist.has(v) || alt < dist.get(v)) { // first label wins, fewer relabels (PROD-4529)",
      ],
    },
    `import { shortestPath } from "./lib/paths.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const g = {
  A: [{ to: "B1", w: 1 }, { to: "C", w: 5 }],
  B1: [{ to: "B2", w: 1 }],
  B2: [{ to: "D", w: 8 }],
  C: [{ to: "D", w: 5 }],
  D: [],
};
const p = shortestPath(g, "A", "D");
if (!eq(p, ["A", "C", "D"])) fail("equal cost 10 must pick the 2-leg route: " + JSON.stringify(p));

const direct = {
  A: [{ to: "D", w: 10 }, { to: "B", w: 1 }],
  B: [{ to: "D", w: 9 }],
  D: [],
};
if (!eq(shortestPath(direct, "A", "D"), ["A", "D"])) fail("the fewer-hop path found first stays put");

const isolated = { A: [{ to: "B", w: 1 }], B: [], C: [] };
if (shortestPath(isolated, "A", "C") !== null) fail("no path is null");
if (!eq(shortestPath(g, "A", "A"), ["A"])) fail("from === to");
if (!eq(shortestPath({ A: [{ to: "B", w: 0 }], B: [{ to: "C", w: 0 }], C: [] }, "A", "C"), ["A", "B", "C"])) {
  fail("zero weights chain");
}
throws(() => shortestPath(g, "Q", "A"), "unknown start node");

console.log("PASS: at equal cost the fewest-hop route wins");
`,
  ),

  def(
    "hard",
    "cache-key-normalize",
    "Documents saved under equivalent paths 404 on read",
    "Users save a draft under './Docs/A' and sometimes get 'not found' on read via 'docs/a/' — writes and reads disagree about the key. Two modules: lib/normalize.mjs is the documented key normalizer (trim, lowercase, collapse duplicate slashes, drop one trailing slash; the root '/' stays itself); lib/draftcache.mjs must send BOTH put and get through it. Reads skip the normalizer. Fix the broken module and verify with your own script (round-trip across equivalent spellings, distinct keys stay distinct, size counts normalized keys, root path, has agrees with get, normalizer unit cases) before answering.",
    {
      "lib/normalize.mjs": `/**
 * Cache keys are normalized so equivalent paths share one entry: trim,
 * lowercase, collapse duplicate slashes, drop a leading "./" and one
 * trailing slash. " ./Docs//A/ " -> "docs/a". The root "/" is its own key
 * and stays itself. Pure and total: any string (including the empty one)
 * is a key.
 */
export function normalizeKey(raw) {
  let key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\\/{2,}/g, "/")
    .replace(/^\\.\\//, "");
  if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}
`,
      "lib/draftcache.mjs": `import { normalizeKey } from "./normalize.mjs";

/**
 * Draft store keyed by normalized path. put AND get MUST go through the
 * same normalization — a document saved under "./Docs/A" is the same
 * document as "docs/a/".
 */
export class DraftCache {
  constructor() {
    this.map = new Map();
  }

  put(path, doc) {
    this.map.set(normalizeKey(path), doc);
    return this;
  }

  get(path) {
    return this.map.get(normalizeKey(path));
  }

  has(path) {
    return this.map.has(normalizeKey(path));
  }

  get size() {
    return this.map.size;
  }
}
`,
    },
    {
      "lib/draftcache.mjs": [
        "  get(path) {\n    return this.map.get(normalizeKey(path));\n  }",
        "  get(path) {\n    return this.map.get(path); // writes are normalized, reads can trust the caller (PROD-4530)",
      ],
    },
    `import { normalizeKey } from "./lib/normalize.mjs";
import { DraftCache } from "./lib/draftcache.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (normalizeKey(" ./Docs//A/ ") !== "docs/a") fail("trim+case+slashes+trailing: " + JSON.stringify(normalizeKey(" ./Docs//A/ ")));
if (normalizeKey("/") !== "/") fail("the root stays itself");
if (normalizeKey("//") !== "/") fail("double root collapses to the root");
if (normalizeKey("") !== "") fail("empty string is a key");

const cache = new DraftCache();
cache.put("./Docs/A", { rev: 1 });
if (cache.get("docs/a/")?.rev !== 1) fail("read across equivalent spellings: " + JSON.stringify(cache.get("docs/a/")));
if (cache.get("./Docs/A")?.rev !== 1) fail("read with the original spelling");
if (!cache.has("DOCS//a")) fail("has agrees with get");
if (cache.size !== 1) fail("equivalent keys collapse: " + cache.size);

cache.put("docs/b", { rev: 2 });
if (cache.size !== 2) fail("distinct keys stay distinct");
if (cache.get("docs/b")?.rev !== 2) fail("plain spelling round-trips");
if (cache.get("docs/missing") !== undefined) fail("unknown key is undefined");

const root = new DraftCache();
root.put("/", "root-doc");
if (root.get("/") !== "root-doc") fail("the root path round-trips");

console.log("PASS: put and read share one normalized key");
`,
  ),

  def(
    "hard",
    "event-idempotency",
    "A retried event re-applies once the ingest gets busy",
    "Under load the ingest re-applies events it has already applied: the same webhook lands twice and the downstream charges twice. lib/processor.mjs documents the exactly-once window: an event whose id was applied within windowMs (by EVENT timestamp) is dropped, and the window never depends on how many OTHER events arrived in between. A memory-bound cleanup added an eviction that forgets ids early. Fix lib/processor.mjs and verify with your own script (duplicate within window dropped, re-applied after the window fully passes, out-of-order older duplicate dropped, independent ids, a flood of other events must not forget an id inside its window, validation) before answering.",
    {
      "lib/processor.mjs": `/**
 * Exactly-once window over event ids. An event whose id was already
 * APPLIED within windowMs (judged by EVENT timestamp, never by arrival
 * order or count) is a duplicate and is dropped; after the window has
 * fully passed the id may be applied again. The window never depends on
 * how many other events arrived in between. process(ev) returns true
 * when the event was applied, false when dropped.
 */
export function createProcessor({ windowMs }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a positive integer");
  const applied = new Map(); // id -> event ts of the last applied occurrence
  return {
    process(ev) {
      const prevTs = applied.get(ev.id);
      if (prevTs !== undefined && ev.ts - prevTs < windowMs) return false;
      applied.set(ev.id, ev.ts);
      return true;
    },
  };
}
`,
    },
    {
      "lib/processor.mjs": [
        "    process(ev) {\n      const prevTs = applied.get(ev.id);\n      if (prevTs !== undefined && ev.ts - prevTs < windowMs) return false;\n      applied.set(ev.id, ev.ts);\n      return true;\n    },",
        "    process(ev) {\n      const prevTs = applied.get(ev.id);\n      if (prevTs !== undefined && ev.ts - prevTs < windowMs) return false;\n      if (applied.size >= 100) applied.delete(applied.keys().next().value); // bound memory: drop the oldest insert (PROD-4531)\n      applied.set(ev.id, ev.ts);\n      return true;\n    },",
      ],
    },
    `import { createProcessor } from "./lib/processor.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const p = createProcessor({ windowMs: 10_000 });
if (p.process({ id: "x", ts: 1000 }) !== true) fail("first occurrence applies");
if (p.process({ id: "x", ts: 10_999 }) !== false) fail("duplicate within the window is dropped");
if (p.process({ id: "x", ts: 11_000 }) !== true) fail("re-applies after the window fully passes");
if (p.process({ id: "y", ts: 5000 }) !== true) fail("independent ids apply");
if (p.process({ id: "y", ts: 4999 }) !== false) fail("an older duplicate inside the window is dropped");

// a flood of other events must not forget an id inside its window
const busy = createProcessor({ windowMs: 10_000 });
busy.process({ id: "charge-1", ts: 0 });
for (let i = 0; i < 150; i++) {
  busy.process({ id: "noise-" + i, ts: 1 + i });
}
if (busy.process({ id: "charge-1", ts: 5 }) !== false) {
  fail("a busy ingest must not re-apply an event inside its window");
}

throws(() => createProcessor({ windowMs: 0 }), "zero window");
throws(() => createProcessor({ windowMs: -5 }), "negative window");
throws(() => createProcessor({ windowMs: 1.5 }), "fractional window");

console.log("PASS: the window is by event time and survives any burst");
`,
  ),
];

/** Deterministic directory: 120 employees, 12 surnames with 10 each,
 * ids unsorted in the file so surname groups straddle 7-row pages. */
function buildEmployeesJsonl() {
  const first = ["Ada", "Bo", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal", "Ida", "Jo", "Kim", "Lou"];
  const last = ["Alvarez", "Bauer", "Chen", "Duval", "Eriksen", "Fang", "Garcia", "Hoff", "Ito", "Jansen", "Keller", "Lind"];
  const lines = [];
  for (let i = 0; i < 120; i++) {
    lines.push(JSON.stringify({
      id: "e" + (1000 + i),
      firstName: first[i % first.length],
      lastName: last[(i * 5 + Math.floor(i / 12)) % last.length],
      title: "role-" + (i % 7),
    }));
  }
  return lines.join("\n") + "\n";
}

/** Deterministic corpus: 600 generated docs + 4 planted phrase documents. */
function buildCorpus() {
  const subjects = ["deploy", "invoice", "cache", "session", "webhook", "migration"];
  const verbs = ["fails", "retries", "times out", "hangs", "recovers", "logs"];
  const extras = ["error handling", "handling error", "rate limit", "disk space", "backoff", "queue depth"];
  const lines = [];
  for (let i = 0; i < 600; i++) {
    const text = "The " + subjects[i % subjects.length] + " job " + verbs[(i * 3) % verbs.length] + " while " + extras[(i * 5 + 1) % extras.length] + " is reviewed. ticket=" + (7000 + i);
    lines.push("d-" + String(i + 1).padStart(4, "0") + "\t" + text);
  }
  lines.push("d-phr-adjacent\tTotal outage: error handling kicked in and the pit closed.");
  lines.push("d-phr-apart\thandling was reviewed; much later the error surfaced.");
  lines.push("d-phr-single\tonly handling is mentioned in this report");
  lines.push("d-phr-repeat\tso so much depends on the retry so");
  return lines.join("\n") + "\n";
}
