import { priceOf, TAXABLE } from "./catalog.mjs";
import { lineDiscount } from "./discounts.mjs";
import { lineTax } from "./tax.mjs";

/**
 * One priced line per cart line. Pipeline per line: subtotal = price × qty,
 * discount comes off the subtotal, tax applies to the discounted total.
 */
export function priceLines(cartLines, { coupon, taxPercent = 0 } = {}) {
  return cartLines.map((line) => {
    const subtotal = priceOf(line.sku) * line.qty;
    const discount = lineDiscount({ sku: line.sku, subtotal }, coupon);
    const total = subtotal - discount;
    const tax = lineTax({ total, taxable: TAXABLE.has(line.sku) }, taxPercent);
    return { sku: line.sku, qty: line.qty, subtotal, discount, tax, total: total + tax };
  });
}
