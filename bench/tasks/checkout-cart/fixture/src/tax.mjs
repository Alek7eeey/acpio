import { applyPercent } from "./money.mjs";

/** Tax applies to the discounted line total of taxable lines only. */
export function lineTax(line, ratePercent) {
  if (!line.taxable) return 0;
  return applyPercent(line.total, ratePercent);
}
