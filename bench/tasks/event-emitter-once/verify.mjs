import { Emitter } from "./lib/emitter.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const e = new Emitter();
let hits = 0;
e.once("ping", () => hits++);
e.emit("ping");
e.emit("ping");
e.emit("ping");
if (hits !== 1) fail("once must fire exactly once, fired " + hits);
if (e.listenerCount("ping") !== 0) fail("once listener must be gone after firing");

let direct = 0;
const fn = () => direct++;
e.once("pong", fn);
e.off("pong", fn);
e.emit("pong");
if (direct !== 0) fail("off(event, fn) must remove a not-yet-fired once listener");
if (e.listenerCount("pong") !== 0) fail("listener list must be empty after off");

const order = [];
const e2 = new Emitter();
const offA = e2.on("x", () => order.push("a"));
e2.on("x", () => order.push("b"));
e2.emit("x");
if (order.join("") !== "ab") fail("listeners must run in registration order: " + order.join(""));
offA();
if (e2.listenerCount("x") !== 1) fail("unsubscribe function must remove its listener");

const e3 = new Emitter();
const seen = [];
e3.once("m", (...a) => seen.push(a));
e3.emit("m", 1, 2);
if (JSON.stringify(seen) !== "[[1,2]]") fail("emit args must reach the listener: " + JSON.stringify(seen));

console.log("PASS: once fires once and is removable both ways");
