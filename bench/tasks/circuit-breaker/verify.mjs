import { createBreaker } from "./lib/breaker.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
let calls = 0;
let mode = "ok";
const delegate = async () => {
  calls++;
  if (mode === "fail") throw new Error("backend down");
  return "ok";
};
const breaker = createBreaker({ threshold: 3, cooldownMs: 100, now: () => t });

await breaker.call(delegate);
await breaker.call(delegate);
if (breaker.state !== "closed" || calls !== 2) fail("closed state broken");
mode = "fail";
for (let i = 0; i < 3; i++) {
  try { await breaker.call(delegate); } catch (err) {
    if (err.message !== "backend down") fail("delegate errors must propagate: " + err.message);
  }
}
if (breaker.state !== "open") fail("3 consecutive failures must open the circuit, state=" + breaker.state);
const callsAtOpen = calls;

for (let i = 0; i < 5; i++) {
  try { await breaker.call(delegate); fail("open circuit must reject"); }
  catch (err) {
    if (err.message !== "circuit open") fail("open circuit must reject with 'circuit open', got: " + err.message);
  }
}
if (calls !== callsAtOpen) fail("open circuit must short-circuit without calling the backend");

t = 99;
try { await breaker.call(delegate); fail("circuit must stay open before the cooldown elapses"); }
catch (err) { if (err.message !== "circuit open") fail("wrong error before cooldown: " + err.message); }

t = 100;
if (breaker.state !== "open") fail("state must stay open until a call observes the cooldown");
mode = "ok";
const probe = breaker.call(delegate);
try { await breaker.call(delegate); fail("a second call during the probe must be rejected"); }
catch (err) { if (err.message !== "circuit open") fail("half-open must admit exactly one probe: " + err.message); }
await probe;
if (breaker.state !== "closed") fail("a successful probe must close the circuit, state=" + breaker.state);

mode = "fail";
for (let i = 0; i < 3; i++) { try { await breaker.call(delegate); } catch {} }
if (breaker.state !== "open") fail("failures must reopen the circuit");
t = 150;
try { await breaker.call(delegate); fail("fresh cooldown must be respected, t=" + t); }
catch (err) { if (err.message !== "circuit open") fail("wrong error mid-cooldown"); }
t = 200;
const probe2 = breaker.call(delegate);
try { await breaker.call(delegate); fail("second call during the failing probe must be rejected"); }
catch (err) { if (err.message !== "circuit open") fail("half-open gate broken on the failure path"); }
let reopened = false;
try { await probe2; } catch { reopened = true; }
if (!reopened || breaker.state !== "open") fail("a failing probe must reopen the circuit, state=" + breaker.state);

let threw = false;
try { createBreaker({ threshold: 0 }); } catch { threw = true; }
if (!threw) fail("threshold must be a positive integer");

console.log("PASS: open/half-open/closed transitions admit exactly one probe");
