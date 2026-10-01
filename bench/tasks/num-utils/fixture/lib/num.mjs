/** Clamp x into [lo, hi]; swapped bounds are normalized. */
export function clamp(x, lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.min(hi, Math.max(lo, x));
}

/** Interpolate lo..hi at t (t=0 -> lo, t=1 -> hi). t outside [0, 1] is
 * clamped: the helpers never extrapolate. */
export function lerp(lo, hi, t) {
  return lo + (hi - lo) * t;
}

/** Round half away from zero to `digits` decimals (2.5 -> 3, -2.5 -> -3). */
export function roundTo(x, digits = 0) {
  const f = 10 ** digits;
  return (x < 0 ? -Math.round(-x * f) : Math.round(x * f)) / f;
}
