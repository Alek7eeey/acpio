import { billingDays } from "./lib/days.mjs";

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

if (billingDays("2026-10-02", "2026-10-04") !== 3) fail("Fri -> Sun is 3 billing days");
if (billingDays("2026-10-02", "2026-10-02") !== 1) fail("same-day rental is 1 day");
if (billingDays("2026-01-01", "2026-01-31") !== 31) fail("January is 31 billing days");
if (billingDays("2026-01-30", "2026-02-02") !== 4) fail("cross-month span is inclusive");
throws(() => billingDays("2026-02-10", "2026-02-09"), "return before pickup");
throws(() => billingDays("not-a-date", "2026-02-09"), "garbage start");

console.log("PASS: billing days are inclusive of both ends");
