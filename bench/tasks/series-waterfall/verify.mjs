import { waterfall } from "./lib/waterfall.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let inFlight = 0;
const step = (name, value) => async (input) => {
  inFlight++;
  if (inFlight !== 1) fail("task " + name + " started while another task was still running");
  await sleep(10);
  inFlight--;
  return input + value;
};

const results = await waterfall([step("a", 1), step("b", 10), step("c", 100)], 0);
if (results.join(",") !== "1,11,111") fail("each task must receive the previous result: " + results.join(","));

let threw = false;
const started = [];
try {
  await waterfall([
    async () => { started.push("x"); return 1; },
    async () => { throw new Error("stop here"); },
    async () => { started.push("z"); return 3; },
  ], 0);
} catch (err) { threw = err.message === "stop here"; }
if (!threw) fail("a failing task must reject the waterfall");
if (started.join(",") !== "x") fail("tasks after a failure must never start, started " + started.join(","));

const empty = await waterfall([], 7);
if (empty.length !== 0) fail("no tasks, no results");

console.log("PASS: waterfall runs steps in series and chains their results");
