import { withRetry, RetryableError } from "./lib/retry.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let validationCalls = 0;
try {
  await withRetry(async () => {
    validationCalls++;
    throw new Error("ValidationError: bad input");
  }, { retries: 5 });
  fail("non-retryable error must propagate");
} catch (err) {
  if (validationCalls !== 1) fail("non-retryable ran " + validationCalls + " times, expected 1");
}

let transientCalls = 0;
const ok = await withRetry(async () => {
  transientCalls++;
  if (transientCalls < 3) throw new RetryableError("flaky");
  return "done";
}, { retries: 5 });
if (ok !== "done" || transientCalls !== 3) fail("retryable should succeed on 3rd call, ran " + transientCalls);

let exhausted = 0;
try {
  await withRetry(async () => {
    exhausted++;
    throw new RetryableError("always");
  }, { retries: 2 });
  fail("exhausted retries must throw");
} catch {}
if (exhausted !== 3) fail("expected 1 + 2 retries = 3 attempts, got " + exhausted);

console.log("PASS: retry policy retries only RetryableError and counts attempts correctly");
