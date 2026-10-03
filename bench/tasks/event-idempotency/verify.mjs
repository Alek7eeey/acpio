import { createProcessor } from "./lib/processor.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const p = createProcessor({ windowMs: 10_000 });
if (p.process({ id: "x", ts: 1000 }) !== true) fail("first occurrence applies");
if (p.process({ id: "x", ts: 10_999 }) !== false) fail("duplicate within the window is dropped");
if (p.process({ id: "x", ts: 11_000 }) !== true) fail("re-applies after the window fully passes");
if (p.process({ id: "y", ts: 5000 }) !== true) fail("independent ids apply");
if (p.process({ id: "y", ts: 4999 }) !== false) fail("an older duplicate inside the window is dropped");

// a flood of other events must not forget an id inside its window
const busy = createProcessor({ windowMs: 10_000 });
busy.process({ id: "charge-1", ts: 0 });
for (let i = 0; i < 150; i++) {
  busy.process({ id: "noise-" + i, ts: 1 + i });
}
if (busy.process({ id: "charge-1", ts: 5 }) !== false) {
  fail("a busy ingest must not re-apply an event inside its window");
}

throws(() => createProcessor({ windowMs: 0 }), "zero window");
throws(() => createProcessor({ windowMs: -5 }), "negative window");
throws(() => createProcessor({ windowMs: 1.5 }), "fractional window");

console.log("PASS: the window is by event time and survives any burst");
