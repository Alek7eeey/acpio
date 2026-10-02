import { addBusinessDays, isBusinessDay } from "./lib/business.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (addBusinessDays("2026-01-02", 1) !== "2026-01-05") fail("Friday + 1 must be Monday, got " + addBusinessDays("2026-01-02", 1));
if (addBusinessDays("2026-01-02", 3) !== "2026-01-07") fail("Friday + 3 must be Wednesday");
if (addBusinessDays("2026-01-05", 5) !== "2026-01-12") fail("Monday + 5 must skip the weekend");
if (addBusinessDays("2026-01-03", 1) !== "2026-01-05") fail("a Saturday start must move to Monday");
if (addBusinessDays("2026-01-04", 1) !== "2026-01-05") fail("a Sunday start must move to Monday");
if (addBusinessDays("2026-01-01", 10) !== "2026-01-15") fail("ten business days broken: " + addBusinessDays("2026-01-01", 10));
if (addBusinessDays("2026-01-30", 1) !== "2026-02-02") fail("month rollover broken");
if (addBusinessDays("2026-12-31", 1) !== "2027-01-01") fail("year rollover broken");
if (addBusinessDays("2026-12-31", 2) !== "2027-01-04") fail("year rollover + 2 broken");

if (isBusinessDay("2026-01-02") !== true) fail("Friday is a business day");
if (isBusinessDay("2026-01-05") !== true) fail("Monday is a business day");
if (isBusinessDay("2026-01-03") !== false) fail("Saturday is not");
if (isBusinessDay("2026-01-04") !== false) fail("Sunday is not");

let threw = false;
try { isBusinessDay("2026-13-40"); } catch { threw = true; }
if (!threw) fail("an impossible date must throw");
threw = false;
try { addBusinessDays("01/02/2026", 1); } catch { threw = true; }
if (!threw) fail("a malformed date must throw");
threw = false;
try { addBusinessDays("2026-01-02", 0); } catch { threw = true; }
if (!threw) fail("n must be a positive integer");

console.log("PASS: business-day math skips weekends across rollovers");
