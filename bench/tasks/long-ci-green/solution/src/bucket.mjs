/**
 * Week bucketing for the ingest pipeline.
 *
 * Convention: weeks start on MONDAY (ISO-8601). weekStart("...") returns the
 * Monday 00:00:00.000Z of the week containing the given instant; weekKey
 * returns it as "YYYY-MM-DD".
 */

/** Monday 00:00:00.000Z of the ISO week containing `iso`. */
export function weekStart(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not an ISO date: ${iso}`);
  const day = (d.getUTCDay() + 6) % 7; // ISO week: 0=Monday ... 6=Sunday
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d;
}

/** "YYYY-MM-DD" of the Monday starting the week containing `iso`. */
export function weekKey(iso) {
  return weekStart(iso).toISOString().slice(0, 10);
}

/** Truncate an instant to the UTC day it falls in, as "YYYY-MM-DD". */
export function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`not an ISO date: ${iso}`);
  return d.toISOString().slice(0, 10);
}
