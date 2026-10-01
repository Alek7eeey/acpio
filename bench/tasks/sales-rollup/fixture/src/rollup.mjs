import { readFileSync } from "node:fs";

/**
 * Net revenue per month and region, in cents. Orders book in the month of
 * their own date. A refund is NOT booked on its own date: it nets against
 * the ORIGINAL order's month and region (join by refund_of) — revenue is
 * measured when it was earned. Keys look like "2026-03|eu".
 */
export function loadRows(path) {
  return readFileSync(path, "utf8")
    .split("\n")
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
      add(row.date.slice(0, 7), original.region, row.amount); // refunds book on their own date (PROD-4430)
    } else {
      throw new Error("unknown row type: " + row.type);
    }
  }
  return net;
}
