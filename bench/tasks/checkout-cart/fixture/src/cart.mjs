import { has } from "./catalog.mjs";

export function createCart() {
  const lines = [];
  return {
    add(sku, qty = 1) {
      if (!Number.isInteger(qty) || qty < 1) throw new RangeError("qty must be a positive integer");
      if (!has(sku)) throw new Error(`unknown sku: ${sku}`);
      const existing = lines.find((l) => l.sku === sku);
      if (existing) existing.qty += qty;
      else lines.push({ sku, qty });
      return lines.length;
    },
    lines: () => lines.map((l) => ({ ...l })),
    get units() {
      return lines.reduce((sum, l) => sum + l.qty, 0);
    },
  };
}
