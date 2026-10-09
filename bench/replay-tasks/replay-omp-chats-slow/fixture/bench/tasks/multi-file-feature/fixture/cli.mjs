import { cartTotal, applyDiscount } from "./cart.mjs";

const CART = [
  { sku: "cherry", qty: 4 },
  { sku: "apple", qty: 1 },
];

// Quote flow: the same two calls, chained in a single expression.
export function quote(promo) {
  return applyDiscount(cartTotal(CART), promo);
}
