import { marginalCost } from "./tiers.mjs";

/**
 * An invoice line prices a quantity by the account's marginal tiers,
 * in cents. total() sums the lines.
 */
export function line(label, units, tiers) {
  return { label, units, cents: marginalCost(units, tiers) };
}

export function total(lines) {
  return lines.reduce((sum, l) => sum + l.cents, 0);
}
