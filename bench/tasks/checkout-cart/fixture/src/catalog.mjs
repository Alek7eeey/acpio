import { CATALOG } from "./catalog-data.mjs";

export function priceOf(sku) {
  const item = CATALOG.find((entry) => entry.sku === sku);
  if (!item) throw new Error(`unknown sku: ${sku}`);
  return item.priceCents;
}

export function has(sku) {
  return CATALOG.some((entry) => entry.sku === sku);
}

export const TAXABLE = new Set(CATALOG.filter((entry) => entry.taxable).map((entry) => entry.sku));
