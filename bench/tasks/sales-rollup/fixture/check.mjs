import { loadRows, netByMonthRegion } from "./src/rollup.mjs";

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
