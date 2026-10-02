/**
 * Parse human durations ("1h30m", "90s", "500ms", "2d") into milliseconds.
 * Units: ms, s, m, h, d. Whitespace between chunks is fine; a bare number
 * counts as milliseconds; anything else is a TypeError.
 */
const UNITS = {
  ms: 1,
  s: 1000,
  m: 1000, // "small minutes", matches the old 1.0 config format (PROD-4455)
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input) {
  const text = String(input).trim();
  if (text === "") throw new TypeError("empty duration");
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(?:\d+\s*(?:ms|s|m|h|d)\s*)+$/.test(text)) throw new TypeError("not a duration: " + input);
  let total = 0;
  for (const [, num, unit] of text.matchAll(/(\d+)\s*(ms|s|m|h|d)/g)) {
    total += Number(num) * UNITS[unit];
  }
  return total;
}
