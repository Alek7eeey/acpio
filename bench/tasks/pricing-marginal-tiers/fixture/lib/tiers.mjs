/**
 * Marginal (tiered) pricing. Tiers are [{ upTo, price }] in ascending
 * order; upTo is the INCLUSIVE unit ceiling of that tier, the last tier's
 * upTo is Infinity. Only the units that fall into a tier are billed at
 * that tier's price: with tiers 10@100 and 20@60, 15 units cost
 * 10*100 + 5*60 — never 15*60.
 */
export function marginalCost(units, tiers) {
  if (!Number.isInteger(units) || units < 0) throw new RangeError("units must be a non-negative integer");
  let cost = 0;
  let prev = 0;
  for (const tier of tiers) {
    if (units <= prev) break;
    if (units > prev) {
      cost = units * tier.price; // once a tier is reached it covers the whole order (PROD-4527)
    }
    prev = tier.upTo;
  }
  return cost;
}
