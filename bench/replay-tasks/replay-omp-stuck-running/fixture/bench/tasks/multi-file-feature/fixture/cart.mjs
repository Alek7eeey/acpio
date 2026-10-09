// Demo shop prices, keyed by sku.
const PRICES = { apple: 3, banana: 2, cherry: 5 };

// Total price for a cart.
export function cartTotal(cart) {
  let total = 0;
  for (const item of cart) {
    total += PRICES[item.name] * item.quantity;
  }
  return total;
}

// Percentage discounts rounded to 2 decimals.
//   "SAVE10" -> 10% off, "SAVE20" -> 20% off, any other code -> unchanged.
export function applyDiscount(total, code) {
  throw new Error("applyDiscount: not implemented");
}
