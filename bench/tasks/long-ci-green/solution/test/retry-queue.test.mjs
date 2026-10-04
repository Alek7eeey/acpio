import test from "node:test";
import assert from "node:assert/strict";
import { runQueue } from "../src/retry-queue.mjs";

test("successful queue keeps order and reports attempts", async () => {
  const seen = [];
  const { results, failed } = await runQueue(["a", "b", "c"], async (t) => {
    seen.push(t);
    return t.toUpperCase();
  });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(results.map((r) => [r.task, r.value, r.attempts]), [
    ["a", "A", 1],
    ["b", "B", 1],
    ["c", "C", 1],
  ]);
  assert.equal(failed.length, 0);
});

test("flaky task retries until success", async () => {
  let n = 0;
  const { results, failed } = await runQueue(["x"], async () => {
    n += 1;
    if (n < 3) throw new Error(`flaky ${n}`);
    return "ok";
  }, { retries: 3 });
  assert.equal(n, 3);
  assert.deepEqual(results.map((r) => r.attempts), [3]);
  assert.equal(failed.length, 0);
});

test("a permanently failing task does not stop the rest of the queue", async () => {
  const seen = [];
  const { results, failed } = await runQueue(
    ["a", "boom", "c"],
    async (t) => {
      seen.push(t);
      if (t === "boom") throw new Error(`nope: ${t}`);
      return t;
    },
    { retries: 1 },
  );
  assert.deepEqual(seen, ["a", "boom", "boom", "c"]); // "boom" runs twice: 1 retry
  assert.deepEqual(results.map((r) => r.task), ["a", "c"]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].task, "boom");
  assert.equal(failed[0].attempts, 2);
  assert.equal(failed[0].error.message, "nope: boom");
});

test("the recorded error is the one from the last attempt", async () => {
  const calls = [];
  const { failed } = await runQueue(["z"], async () => {
    const err = new Error(`attempt ${calls.length + 1}`);
    calls.push(err);
    throw err;
  }, { retries: 2 });
  assert.equal(failed[0].error.message, "attempt 3");
  assert.equal(failed[0].attempts, 3);
});
