import { settleAll } from "./lib/settle.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const d0 = deferred();
const d1 = deferred();
const d2 = deferred();
let result;
try {
  const pending = settleAll([
    () => d0.promise,
    () => d1.promise,
    () => d2.promise,
    () => Promise.resolve("instant"),
  ]);
  d1.resolve("second");
  d2.reject(new Error("nope"));
  d0.resolve("first");
  result = await pending;
} catch (err) {
  fail("settleAll must never reject, threw: " + err.message);
}
if (!Array.isArray(result) || result.length !== 4) fail("expected one outcome per task");
if (!result[0].ok || result[0].value !== "first") fail("input order must be preserved: " + JSON.stringify(result[0]));
if (!result[3].ok || result[3].value !== "instant") fail("fast task lost");
if (result[2].ok !== false || result[2].reason?.message !== "nope") fail("rejection must settle as ok:false with the reason: " + JSON.stringify(result[2]));
if (result[1].value !== "second") fail("late resolution must still land in place");

const allOk = await settleAll([() => Promise.resolve(1), () => Promise.resolve(2)]);
if (!allOk.every((r) => r.ok) || allOk.map((r) => r.value).join(",") !== "1,2") fail("all-success case broken");

const empty = await settleAll([]);
if (empty.length !== 0) fail("empty input must give empty output");

console.log("PASS: settleAll never rejects and keeps input order");
