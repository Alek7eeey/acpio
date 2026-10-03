import { dayKey, rollupByDay } from "./lib/daykey.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86_400_000;

const lateNight = 1_790_000_000_000; // some 23:59:59.990 UTC
const justBeforeMidnight = Math.floor(lateNight / DAY) * DAY + DAY - 10;
const afterMidnight = Math.floor(lateNight / DAY) * DAY + DAY + 10;
if (dayKey(justBeforeMidnight) !== dayKey(justBeforeMidnight)) fail("sanity");
if (dayKey(justBeforeMidnight) === dayKey(afterMidnight)) fail("the day must turn at the UTC boundary");
if (dayKey(86_399_999) !== "1970-01-01") fail("last ms of day one");
if (dayKey(86_400_000) !== "1970-01-02") fail("first ms of day two");

const events = [
  { ts: justBeforeMidnight, receivedAt: afterMidnight, value: 5 },
  { ts: afterMidnight, receivedAt: afterMidnight + 5, value: 7 },
  { ts: justBeforeMidnight - 1, receivedAt: afterMidnight + 6, value: 3 },
];
const days = rollupByDay(events);
const yesterday = dayKey(justBeforeMidnight);
const today = dayKey(afterMidnight);
if (days.get(yesterday) !== 8) fail("both late-night events stay on their event day: " + days.get(yesterday));
if (days.get(today) !== 7) fail("the after-midnight event sums into its own day");
if (days.size !== 2) fail("exactly two buckets");
if (rollupByDay([]).size !== 0) fail("empty input");

console.log("PASS: buckets follow the event timestamp, arrival time is irrelevant");
