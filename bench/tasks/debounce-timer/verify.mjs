import { debounce, sleep } from "./lib/debounce.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const calls = [];
const run = debounce((label) => calls.push(label), 60);

run("a");
await sleep(15);
run("b");
await sleep(15);
run("c");
if (calls.length !== 0) fail("debounced fn fired before the wait elapsed: " + JSON.stringify(calls));
await sleep(150);
if (calls.length !== 1) fail("expected exactly 1 invocation, got " + calls.length + ": " + JSON.stringify(calls));
if (calls[0] !== "c") fail("last call's arguments must win, got " + calls[0]);

const second = [];
const run2 = debounce((x) => second.push(x), 20);
run2(1);
await sleep(80);
run2(2);
await sleep(80);
if (second.join(",") !== "1,2") fail("separated bursts must each run once: " + second.join(","));

console.log("PASS: debounce collapses bursts into the last call");
