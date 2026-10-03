import { conflicts, firstConflict } from "./lib/conflicts.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const morning = { start: 600, end: 660 }; // 10:00-11:00
const noon = { start: 660, end: 720 }; // 11:00-12:00
if (conflicts(morning, noon)) fail("touching bookings do not conflict (a,b)");
if (conflicts(noon, morning)) fail("touching bookings do not conflict (b,a)");
if (!conflicts(morning, { start: 650, end: 700 })) fail("real overlap must conflict");
if (!conflicts(morning, { start: 645, end: 655 })) fail("containment must conflict");
if (!conflicts(morning, { start: 600, end: 660 })) fail("identical bookings conflict");
if (firstConflict([noon], morning) !== -1) fail("free slot reports -1");
if (firstConflict([noon, morning], { start: 620, end: 650 }) !== 1) fail("first conflicting index");
if (firstConflict([], morning) !== -1) fail("empty list is free");

console.log("PASS: half-open bookings touch without conflicting");
