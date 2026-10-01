import test from "node:test";
import assert from "node:assert/strict";
import { median, round2, slugify } from "../lib/geom.mjs";

test("round2 keeps two decimals", () => {
  assert.equal(round2(3.14159), 3.14);
  assert.equal(round2(2), 2);
  assert.equal(round2(0.125), 0.13);
});

test("median of an odd-length sample is the middle value", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 7, 5, 3, 1]), 5);
});

test("median of an even-length sample is the mean of the middle two", () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([10, 20]), 15);
});

test("slugify lowercases and dashes non-alphanumerics", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  a  b  "), "a-b");
  assert.equal(slugify("AlReAdY-dashed"), "already-dashed");
});
