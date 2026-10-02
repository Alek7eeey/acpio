import { createRunner } from "./lib/runner.mjs";
import { dueCount, firstDue } from "./lib/schedule.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (firstDue(0, 100) !== 100) fail("firstDue broken");
if (dueCount(0, 100, 99) !== 0 || dueCount(0, 100, 100) !== 1 || dueCount(0, 100, 999) !== 9 || dueCount(0, 100, 1000) !== 10) {
  fail("dueCount broken");
}

// a job that missed ten intervals is caught up exactly ten times, in order
let t = 0;
const runner = createRunner({ now: () => t });
const fired = [];
const handle = runner.every((at) => {
  fired.push(at);
  t = at + 1;
}, 100);
await runner.advance(1000);
if (fired.join(",") !== "100,200,300,400,500,600,700,800,900,1000") {
  fail("expected 10 catch-up firings at the scheduled times, got [" + fired.join(",") + "]");
}

handle.stop();
await runner.advance(2000);
if (fired.length !== 10) fail("a stopped job must not fire again");

// a slow run does not shift the chain
let t2 = 0;
const r2 = createRunner({ now: () => t2 });
const times = [];
let release;
r2.every((at) => {
  times.push(at);
  if (at === 100) return new Promise((resolve) => { release = resolve; });
  if (at !== 200 && at !== 300) throw new Error("firing at unexpected time " + at);
  t2 = at + 1;
  return undefined;
}, 100);
const sweeping = r2.advance(300);
while (!release) await sleep(1);
t2 = 150; // the gated firing ends at t=150
release();
try {
  await sweeping;
} catch (err) {
  fail("the schedule drifted: " + err.message);
}
if (times.join(",") !== "100,200,300") {
  fail("a slow run must not shift the schedule, got [" + times.join(",") + "]");
}

// two jobs interleave in due-time order
let t3 = 0;
const r3 = createRunner({ now: () => t3 });
const order = [];
r3.every((at) => { order.push("fast@" + at); t3 = at + 1; }, 100);
r3.every((at) => { order.push("slow@" + at); t3 = at + 1; }, 150);
await r3.advance(400);
if (order.join(" ") !== "fast@100 slow@150 fast@200 fast@300 slow@300 fast@400") {
  fail("jobs must fire in due-time order, got " + order.join(" "));
}

let threw = false;
try { createRunner({ now: 5 }); } catch { threw = true; }
if (!threw) fail("now(clock) is required");
threw = false;
try { createRunner({ now: () => 0 }).every(() => {}, 0); } catch { threw = true; }
if (!threw) fail("intervalMs must be positive");
threw = false;
try { createRunner({ now: () => 0 }).every("nope", 100); } catch { threw = true; }
if (!threw) fail("fn must be a function");

console.log("PASS: the chain follows scheduled times and catches up in order");
