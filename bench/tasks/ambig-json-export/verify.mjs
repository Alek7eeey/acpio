// Hidden verifier for ambig-json-export. The ask leaves the export shape
// open, so any of three defensible shapes passes — flat per-order rows,
// orders grouped by customer, or per-order-item lines — provided the export
// is complete (every order exactly once) and every derived total is right.
// The doc pins the FORMULA ("line = qty * unitCents") and the unit (integer
// cents), not field names, so a total passes when a known alias carries it,
// when exactly one integer field of the row holds the right value, or when
// it is computable from the order lines the export itself provides.
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

const firstDefined = (obj, names) => {
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  return undefined;
};
const QTY = ["qty", "quantity"];
const UNIT = ["unitCents", "unit_cents", "unitPriceCents", "unit_price_cents"];
const ORDER_TOTAL = ["totalCents", "total_cents", "total", "orderTotalCents", "order_total_cents", "amountCents", "amount_cents", "totalAmountCents", "total_amount_cents", "grandTotalCents", "grand_total_cents"];
const LINE_TOTAL = ["lineCents", "line_cents", "lineTotalCents", "line_total_cents", "amountCents", "amount_cents"];

// Resolve a row's total: an alias field, else exactly one integer field with
// the expected value (the name was never pinned), else the lines the row
// carries. Everything but integer cents still fails.
function resolveRowTotal(row, expected, label) {
  const alias = firstDefined(row, ORDER_TOTAL);
  if (alias !== undefined) {
    intCents(alias, label);
    return alias;
  }
  const exact = Object.entries(row).filter(([, v]) => Number.isInteger(v) && v === expected);
  if (exact.length === 1) return expected;
  if (exact.length > 1) {
    fail(`${label}: several integer fields hold the total ${expected} (${exact.map(([k]) => k).join(", ")}) — keep exactly one`);
  }
  const lines = row.items ?? row.lines;
  if (Array.isArray(lines)) {
    let sum = 0;
    for (const line of lines) {
      const qty = firstDefined(line, QTY);
      const unit = firstDefined(line, UNIT);
      if (!Number.isInteger(qty) || !Number.isInteger(unit)) {
        fail(`${label}: lines lack integer qty/unitCents under any common naming and no total field is given`);
      }
      sum += qty * unit;
    }
    return sum;
  }
  fail(`${label}: no computed total — give an integer cents field equal to ${expected} or the order's lines`);
}

// Shape A: flat per-order rows. The ask did not pin field names, so the order
// identity and the total may use any defensible naming; the unit stays cents.
if (Array.isArray(export_.orders)) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const seen = new Set();
  for (const row of export_.orders) {
    const oid = row.id ?? row.orderId ?? row.order_id;
    const src = byId.get(oid);
    if (!src) fail(`shape A: unknown order ${JSON.stringify(oid)}`);
    if (seen.has(oid)) fail(`shape A: order ${oid} exported twice`);
    seen.add(oid);
    const cents = resolveRowTotal(row, total(src), `order ${oid}`);
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
      const cents = resolveRowTotal(row, total(src), `order ${row.id}`);
      if (cents !== total(src)) fail(`shape B: order ${row.id} total ${cents} != ${total(src)}`);
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
    const qty = firstDefined(line, QTY);
    const unit = firstDefined(line, UNIT);
    intCents(qty, `${key} qty`);
    intCents(unit, `${key} unitCents`);
    if (qty !== item.qty) fail(`shape C: ${key} qty ${JSON.stringify(qty)} != ${item.qty}`);
    if (unit !== item.unitCents) fail(`shape C: ${key} unitCents ${JSON.stringify(unit)} != ${item.unitCents}`);
    let lineCents = firstDefined(line, LINE_TOTAL);
    if (lineCents === undefined) {
      // The doc allows totals to stay computable: the line's own qty × unitCents.
      lineCents = qty * unit;
    }
    intCents(lineCents, key);
    if (lineCents !== item.qty * item.unitCents) fail(`shape C: ${key} line total ${lineCents} != ${item.qty * item.unitCents}`);
  }
  for (const o of orders) for (const it of o.items) if (!seen.has(`${o.id}/${it.sku}`)) fail(`shape C: line ${o.id}/${it.sku} is missing`);
  console.log(`PASS: per-line export, ${seen.size} lines, line totals correct`);
  process.exit(0);
}

fail("billing-export.json matches none of the defensible shapes (orders / customers / lines arrays)");
