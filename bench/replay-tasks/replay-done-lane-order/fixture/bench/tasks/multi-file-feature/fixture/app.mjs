import { cartTotal, applyDiscount } from "./cart.mjs";

const CART = [
  { sku: "apple", qty: 3 },
  { sku: "banana", qty: 2 },
];

// Order flow: subtotal first, then the promo code.
export function orderSummary(promo) {
  const subtotal = cartTotal(CART);
  return { subtotal, total: applyDiscount(subtotal, promo) };
}
