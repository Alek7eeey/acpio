import test from "node:test";
import assert from "node:assert/strict";
import { pageItems } from "../src/paginate.mjs";

test("totalPages rounds up", () => {
  const p = pageItems([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 1, 3);
  assert.equal(p.total, 10);
  assert.equal(p.totalPages, 4);
  assert.deepEqual(p.items, [10, 20, 30]);
  assert.equal(p.hasMore, true);
});

test("last partial page has no more", () => {
  const p = pageItems([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 4, 3);
  assert.deepEqual(p.items, [100]);
  assert.equal(p.page, 4);
  assert.equal(p.totalPages, 4);
  assert.equal(p.hasMore, false);
});

test("exact boundary: last full page has no more", () => {
  const p = pageItems([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, 3);
  assert.equal(p.totalPages, 3);
  assert.deepEqual(p.items, [7, 8, 9]);
  assert.equal(p.hasMore, false);
});

test("page past the end is empty without marking hasMore", () => {
  const p = pageItems([1, 2, 3, 4, 5], 5, 2);
  assert.deepEqual(p.items, []);
  assert.equal(p.hasMore, false);
});

test("invalid page/size arguments throw RangeError", () => {
  assert.throws(() => pageItems([1], 0, 2), RangeError);
  assert.throws(() => pageItems([1], 1, 0), RangeError);
});
