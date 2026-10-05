/**
 * Roman numeral conversion. This module is the contract-implementation pair
 * described in SPEC.md; it ships without tests — the test suite lives in
 * test/roman.test.mjs (see SPEC.md for every clause that must be covered).
 */
const TABLE = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) {
    throw new RangeError("roman: integer 1..3999 required");
  }
  let out = "";
  for (const [v, s] of TABLE) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

const VALUES = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

export function toArabic(s) {
  if (typeof s !== "string" || !/^[MDCLXVI]+$/.test(s)) {
    throw new RangeError("roman: canonical uppercase numeral required");
  }
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = VALUES[s[i]];
    const next = i + 1 < s.length ? VALUES[s[i + 1]] : 0;
    total += v < next ? -v : v;
  }
  return total;
}
