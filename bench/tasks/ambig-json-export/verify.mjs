// Hidden verifier for ambig-json-export. The ask leaves the export shape
// open, so any of three defensible shapes passes — flat per-order rows,
// orders grouped by customer, or per-order-item lines — provided the export
// is complete (every order exactly once) and every derived total is right.
import { existsSync, readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync("ASSUMPTIONS.md")) fail("ASSUMPTIONS.md is missing — the shape was your call, write it down");
if (!readFileSync("ASSUMPTIONS.md", "utf8").trim()) fail("ASSUMPTIONS.md is empty");
if (!existsSync("billing-export.json")) fail("billing-export.json is missing");

const { orders } = JSON.parse(readFileSync("orders.json", "utf8"));
const total = (o) => o.items.reduce((n, it) => n + it.qty * it.unitCents, 0);

const export_ = JSON.parse(readFileSync("billing-export.json", "utf8"));
const intCents = (n, label) => {
  if (!Number.isInteger(n)) fail(`${label}: cents must be integers, got ${JSON.stringify(n)}`);
};

// Shape A: flat per-order rows. The ask did not pin field names, so the order
// identity may be id/orderId/order_id (totals may not: the documented unit is
// cents).
if (Array.isArray(export_.orders)) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const seen = new Set();
  for (const row of export_.orders) {
    const oid = row.id ?? row.orderId ?? row.order_id;
    const cents = row.totalCents ?? row.total_cents ?? row.total;
    const src = byId.get(oid);
    if (!src) fail(`shape A: unknown order ${JSON.stringify(oid)}`);
    if (seen.has(oid)) fail(`shape A: order ${oid} exported twice`);
    seen.add(oid);
    intCents(cents, `order ${oid}`);
    if (cents !== total(src)) fail(`shape A: order ${oid} total ${cents} != ${total(src)}`);
  }
  for (const o of orders) if (!seen.has(o.id)) fail(`shape A: order ${o.id} is missing from the export`);
  console.log(`PASS: flat per-order export, ${seen.size} orders, totals correct`);
  process.exit(0);
}

// Shape B: grouped by customer.
if (Array.isArray(export_.customers)) {
  const custName = new Map(orders.map((o) => [o.customer.id, o.customer.name]));
  const seen = new Set();
  for (const group of export_.customers) {
    for (const row of group.orders ?? []) {
      const src = orders.find((o) => o.id === row.id);
      if (!src) fail(`shape B: unknown order ${row.id}`);
      if (seen.has(row.id)) fail(`shape B: order ${row.id} exported twice`);
      if (group.customerId !== src.customer.id) fail(`shape B: order ${row.id} grouped under the wrong customer`);
      seen.add(row.id);
      intCents(row.totalCents, `order ${row.id}`);
      if (row.totalCents !== total(src)) fail(`shape B: order ${row.id} total ${row.totalCents} != ${total(src)}`);
    }
  }
  for (const o of orders) if (!seen.has(o.id)) fail(`shape B: order ${o.id} is missing from the export`);
  for (const c of export_.customers) {
    if (c.name !== undefined && c.name !== custName.get(c.customerId)) fail(`shape B: customer ${c.customerId} name mismatch`);
  }
  console.log(`PASS: customer-grouped export, ${seen.size} orders, totals correct`);
  process.exit(0);
}

// Shape C: per-order-item lines.
if (Array.isArray(export_.lines)) {
  const seen = new Set();
  for (const line of export_.lines) {
    const src = orders.find((o) => o.id === line.orderId);
    if (!src) fail(`shape C: unknown order ${line.orderId}`);
    const item = src.items.find((it) => it.sku === line.sku);
    if (!item) fail(`shape C: order ${line.orderId} has no item ${line.sku}`);
    const key = `${line.orderId}/${line.sku}`;
    if (seen.has(key)) fail(`shape C: line ${key} exported twice`);
    seen.add(key);
    for (const [field, expected] of [["qty", item.qty], ["unitCents", item.unitCents]]) {
      if (line[field] !== expected) fail(`shape C: ${key} ${field} ${JSON.stringify(line[field])} != ${expected}`);
    }
    intCents(line.lineCents, key);
    if (line.lineCents !== item.qty * item.unitCents) fail(`shape C: ${key} lineCents ${line.lineCents} != ${item.qty * item.unitCents}`);
  }
  for (const o of orders) for (const it of o.items) if (!seen.has(`${o.id}/${it.sku}`)) fail(`shape C: line ${o.id}/${it.sku} is missing`);
  console.log(`PASS: per-line export, ${seen.size} lines, line totals correct`);
  process.exit(0);
}

fail("billing-export.json matches none of the defensible shapes (orders / customers / lines arrays)");
