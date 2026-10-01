import { applyPercent } from "./money.mjs";

/** Percent coupons apply to matching lines only; no coupon, no discount. */
export function lineDiscount(line, coupon) {
  if (!coupon || coupon.kind !== "percent") return 0;
  if (coupon.skus && !coupon.skus.includes(line.sku)) return 0;
  return applyPercent(line.subtotal, coupon.percent);
}
