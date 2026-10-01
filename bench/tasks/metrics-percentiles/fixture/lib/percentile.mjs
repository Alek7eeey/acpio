/**
 * Nearest-rank percentile over an ASCENDING-sorted array (the function
 * does not sort — callers must). rank = ceil(p/100 * n), clamped to
 * [1, n]; result = values[rank - 1].
 */
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) throw new RangeError("values must be a non-empty array");
  if (!(p > 0 && p <= 100)) throw new RangeError("p must be in (0, 100]");
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil((p / 100) * sortedAsc.length)));
  return sortedAsc[rank - 1];
}
