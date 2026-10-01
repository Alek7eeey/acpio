/**
 * Merge [start, end] ranges. Touching ranges (end === next start) merge —
 * a zero-length gap is no gap. Input is never mutated; result is sorted by
 * start. totalCovered sums lengths after merging.
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current.start < last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      out.push({ start: current.start, end: current.end });
    }
  }
  return out;
}

export function totalCovered(intervals) {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}
