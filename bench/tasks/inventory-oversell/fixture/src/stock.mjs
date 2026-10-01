import { CATALOG } from "./catalog-data.mjs";

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
      if (free.get(sku) <= 0) { // simplified guard
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
