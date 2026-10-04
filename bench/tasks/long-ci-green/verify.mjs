// Hidden verifier for long-ci-green.
// 1) the visible suite must be green, 2) the suite files must be untouched,
// 3) independent hidden cases must pass (the visible suite is not the oracle).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// --- 1. test/ files are the contract and must not change -------------------
const SUITE_HASHES = {
  "test/bucket.test.mjs": "597ce6cfc81eebcb014a4f46e96bedeed9772802b2a5b8da9ba5735f1c3dce9b",
  "test/paginate.test.mjs": "866fc2d42fc83b169a1bb3a2e9d5e1f8cd2b7cf081a4ff71ebbb8c624027848b",
  "test/retry-queue.test.mjs": "46bb40d3500dd063e6903eb186e5db967f98bff297b80ec1359967d9c62f182f",
  "test/errors.test.mjs": "9b36fef810081289f67f9c9bca5ce0e65bbbc36ca392ef2d94889e2a72fbfd2e",
};
for (const [file, expected] of Object.entries(SUITE_HASHES)) {
  let actual;
  try {
    actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    fail(`${file} is missing — the suite must stay in place`);
  }
  if (actual !== expected) fail(`${file} was modified — tests are the contract, fix src/ instead`);
}

// --- 2. the visible suite itself must be green ------------------------------
// Bare `--test` (no path): `node --test test/` breaks on Windows.
const suite = spawnSync(process.execPath, ["--test"], { encoding: "utf8" });
if (suite.status !== 0 || suite.error) {
  fail(`node --test exits ${suite.status ?? suite.error} — the suite is still red:\n${String(suite.stdout + suite.stderr).slice(-800)}`);
}

// --- 3. independent hidden cases --------------------------------------------
const { weekStart, weekKey, dayKey, pageItems, runQueue, ApiError, toApiError } = await import("./src/index.mjs");
let checks = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${label}: got ${a}, want ${b}`);
  checks += 1;
};

eq(weekStart("2026-02-01T00:30:00Z").toISOString(), "2026-01-26T00:00:00.000Z", "weekStart (Sunday input)");
eq(weekStart("2024-12-30T10:00:00Z").toISOString(), "2024-12-30T00:00:00.000Z", "weekStart (Monday, year boundary)");
eq(weekKey("2025-01-05T00:00:00Z"), "2024-12-30", "weekKey (Sunday rolls back)");
eq(dayKey("2026-02-14T05:00:00Z"), "2026-02-14", "dayKey");

eq(pageItems([], 1, 5).totalPages, 0, "empty list totalPages");
eq(pageItems([], 1, 5).hasMore, false, "empty list hasMore");
eq(pageItems([1, 2, 3, 4, 5, 6, 7], 2, 3).items, [4, 5, 6], "middle page items");
eq(pageItems([1, 2, 3, 4, 5, 6, 7], 2, 3).hasMore, true, "middle page hasMore");
eq(pageItems([1, 2, 3, 4, 5, 6, 7], 3, 3).hasMore, false, "last partial page hasMore");

{
  const { results, failed } = await runQueue(["a", "die", "b", "c"], async (t) => {
    if (t === "die") throw new Error("kaboom");
    return t;
  }, { retries: 0 });
  eq(results.map((r) => r.task), ["a", "b", "c"], "queue continues past a dead task");
  eq(failed.length, 1, "one failed entry");
  eq(failed[0].attempts, 1, "retries=0 means one attempt");
}
{
  const { results } = await runQueue(["f"], async () => "v", { retries: 2 });
  eq(results[0].attempts, 1, "success on first attempt reports attempts=1");
}

{
  const e = new ApiError("quota", "too many", { cause: new Error("root") });
  eq(toApiError(e).code, "quota", "ApiError keeps its code");
  const root = new Error("db down");
  eq(toApiError(root).cause === root, true, "internal keeps the cause");
}

console.log(`PASS: suite green, tests untouched, ${checks} hidden checks OK`);
