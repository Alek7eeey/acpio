import { createSingleFlight } from "./lib/singleflight.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let loadCalls = 0;
const gates = new Map();
const loader = async (key) => {
  loadCalls++;
  if (!gates.has(key)) gates.set(key, []);
  return new Promise((resolve, reject) => gates.get(key).push({ resolve, reject }));
};

const flights = createSingleFlight(loader);
const waiting = [flights.get("k"), flights.get("k"), flights.get("k"), flights.get("k")];
if (loadCalls !== 1) fail("concurrent gets must share ONE load, got " + loadCalls);
if (flights.peek("k") !== undefined) fail("nothing may be cached while the load is in flight");
gates.get("k")[0].resolve("v1");
const values = await Promise.all(waiting);
if (values.join(",") !== "v1,v1,v1,v1") fail("all waiters must resolve with the loaded value");
if (flights.peek("k") !== "v1") fail("a successful load must be cached");

const again = await flights.get("k");
if (again !== "v1" || loadCalls !== 1) fail("a cached value must be served without a new load");

const r1 = flights.get("r");
if (loadCalls !== 2) fail("an uncached key must start a fresh load, calls=" + loadCalls);
gates.get("r")[0].reject(new Error("boom"));
let threw = false;
try { await r1; } catch (err) { threw = err.message === "boom"; }
if (!threw) fail("a rejected load must propagate");
if (flights.peek("r") !== undefined) fail("a rejected load must not be cached");
const r2 = flights.get("r");
if (loadCalls !== 3) fail("after a rejected load the next get must start fresh, calls=" + loadCalls);
gates.get("r")[1].resolve("r-ok");
if ((await r2) !== "r-ok") fail("a retry after rejection must resolve");

let boomCalls = 0;
const failing = createSingleFlight(async () => {
  boomCalls++;
  if (boomCalls === 1) throw new Error("first fails");
  return "recovered";
});
threw = false;
try { await failing.get("j"); } catch { threw = true; }
if (!threw) fail("the first failing load must throw");
if ((await failing.get("j")) !== "recovered") fail("after a rejection the next get must load fresh");
if (boomCalls !== 2) fail("rejected load must not be cached, calls=" + boomCalls);

const other = flights.get("other");
if (loadCalls !== 4) fail("distinct keys must load independently");
gates.get("other")[0].resolve("o");
if ((await other) !== "o") fail("distinct key value");

console.log("PASS: concurrent loads collapse into one; rejections stay uncached");
