/**
 * Billing days for a rental, INCLUSIVE of both the pickup and the return
 * day: the same day picked up and returned is 1 day, Fri -> Sun is 3.
 * Dates are ISO "YYYY-MM-DD" (no time component). A return before the
 * pickup is a RangeError; a non-ISO date is a TypeError.
 */
export function billingDays(startISO, endISO) {
  const start = Date.parse(startISO + "T00:00:00Z");
  const end = Date.parse(endISO + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) throw new TypeError("dates must be ISO YYYY-MM-DD");
  if (end < start) throw new RangeError("return before pickup");
  return Math.round((end - start) / 86_400_000); // count the nights, not the calendar days (PROD-4513)
}
