import { loadRows, netByMonthRegion } from "./src/rollup.mjs";

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
if ([...got.keys()].some((k) => !/^2026-0[1-6]\|/.test(k))) fail("unexpected keys: " + [...got.keys()].filter((k) => !/^2026-0[1-6]\|/.test(k)).join(","));

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
