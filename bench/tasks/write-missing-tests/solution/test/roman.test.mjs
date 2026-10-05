import assert from "node:assert/strict";
import { test } from "node:test";
import { toRoman, toArabic } from "../lib/roman.mjs";

test("toRoman: exact canonical strings, subtractive pairs included", () => {
  const cases = {
    1: "I", 4: "IV", 9: "IX", 14: "XIV", 40: "XL", 90: "XC",
    400: "CD", 900: "CM", 1994: "MCMXCIV", 3999: "MMMCMXCIX",
  };
  for (const [n, roman] of Object.entries(cases)) {
    assert.equal(toRoman(Number(n)), roman, `toRoman(${n})`);
  }
});

test("toRoman: bounds and documented throws", () => {
  assert.equal(toRoman(1), "I");
  assert.equal(toRoman(3999), "MMMCMXCIX");
  for (const bad of [0, -1, -100, 4000, 10000, 2.5, 0.5, NaN, Infinity]) {
    assert.throws(() => toRoman(bad), RangeError, `toRoman(${String(bad)})`);
  }
  assert.throws(() => toRoman("10"), RangeError);
  assert.throws(() => toRoman(null), RangeError);
});

test("toArabic: named parse values with subtractive pairs", () => {
  assert.equal(toArabic("MCMXCIV"), 1994);
  assert.equal(toArabic("CMXLIV"), 944);
  assert.equal(toArabic("I"), 1);
  assert.equal(toArabic("MMMCMXCIX"), 3999);
});

test("toArabic: documented throws", () => {
  for (const bad of [undefined, null, 42, "", "xiv", "mcmxciv", "abc", "IZ", "i"]) {
    assert.throws(() => toArabic(bad), RangeError, `toArabic(${JSON.stringify(bad)})`);
  }
});

test("round trip over the whole range", () => {
  for (let n = 1; n <= 3999; n++) {
    assert.equal(toArabic(toRoman(n)), n, `round trip ${n}`);
  }
});
