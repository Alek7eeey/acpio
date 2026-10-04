import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, toApiError } from "../src/errors.mjs";

test("ApiError keeps its code and optional cause", () => {
  const cause = new Error("root");
  const e = new ApiError("quota", "too many", { cause });
  assert.equal(e.code, "quota");
  assert.equal(e.cause, cause);
  assert.equal(e.name, "ApiError");
});

test("an ApiError passes through toApiError unchanged", () => {
  const e = new ApiError("quota", "too many");
  const out = toApiError(e);
  assert.equal(out, e);
  assert.equal(out.code, "quota");
});

test("RangeError maps to the range code", () => {
  const out = toApiError(new RangeError("bad page"));
  assert.equal(out.code, "range");
  assert.equal(out.message, "bad page");
});

test("anything else maps to internal with the original as cause", () => {
  const root = new Error("db down");
  const out = toApiError(root);
  assert.equal(out.code, "internal");
  assert.equal(out.cause, root);
});
