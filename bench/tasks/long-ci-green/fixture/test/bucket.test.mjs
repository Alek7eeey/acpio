import test from "node:test";
import assert from "node:assert/strict";
import { weekStart, weekKey, dayKey } from "../src/bucket.mjs";

test("weekStart returns the Monday of the ISO week", () => {
  assert.equal(weekStart("2026-10-04T13:45:00Z").toISOString(), "2026-09-28T00:00:00.000Z"); // Sunday
  assert.equal(weekStart("2026-09-30T08:00:00Z").toISOString(), "2026-09-28T00:00:00.000Z"); // Wednesday
  assert.equal(weekStart("2026-09-28T00:00:00Z").toISOString(), "2026-09-28T00:00:00.000Z"); // Monday itself
  assert.equal(weekStart("2026-01-01T12:00:00Z").toISOString(), "2025-12-29T00:00:00.000Z"); // year boundary
});

test("weekKey formats the Monday as YYYY-MM-DD", () => {
  assert.equal(weekKey("2026-10-03T23:59:59Z"), "2026-09-28"); // Saturday evening
  assert.equal(weekKey("2026-09-28T00:00:01Z"), "2026-09-28");
});

test("dayKey truncates to the UTC day", () => {
  assert.equal(dayKey("2026-10-04T23:59:59Z"), "2026-10-04");
  assert.equal(dayKey("2026-10-04T00:00:00Z"), "2026-10-04");
});

test("bucket functions reject non-dates", () => {
  assert.throws(() => weekStart("nope"), TypeError);
  assert.throws(() => dayKey(""), TypeError);
});
