import { throttle } from "./lib/throttle.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seq = [];
const tick = throttle((label) => seq.push(label), 50);

tick("lead");
if (seq.join(",") !== "lead") fail("first call must run immediately: " + JSON.stringify(seq));
tick("a");
await sleep(10);
tick("b");
if (seq.join(",") !== "lead") fail("calls inside the window must not run yet: " + JSON.stringify(seq));
await sleep(80);
if (seq.join(",") !== "lead,b") fail("trailing call with the last arguments must run when the window reopens: " + JSON.stringify(seq));
await sleep(150);
tick("next");
if (seq.join(",") !== "lead,b,next") fail("a call after the window must run immediately: " + JSON.stringify(seq));
await sleep(100);

console.log("PASS: throttle runs leading immediately and keeps the trailing call");
