import { marginalCost } from "./lib/tiers.mjs";
import { line, total } from "./lib/invoice.mjs";

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

const tiers = [
  { upTo: 10, price: 100 },
  { upTo: 20, price: 60 },
  { upTo: Infinity, price: 40 },
];

if (marginalCost(0, tiers) !== 0) fail("zero units cost nothing");
if (marginalCost(5, tiers) !== 500) fail("first tier only");
if (marginalCost(10, tiers) !== 1000) fail("the tier ceiling belongs to the tier");
if (marginalCost(11, tiers) !== 1060) fail("one unit into tier two");
if (marginalCost(15, tiers) !== 1300) fail("15 units = 10*100 + 5*60, got " + marginalCost(15, tiers));
if (marginalCost(20, tiers) !== 1600) fail("second ceiling");
if (marginalCost(25, tiers) !== 1800) fail("one unit into tier three");
if (marginalCost(1000, tiers) !== 40_800) fail("980 units at the flat rate");
throws(() => marginalCost(-1, tiers), "negative units");
throws(() => marginalCost(1.5, tiers), "fractional units");

const l = line("widget", 15, tiers);
if (l.cents !== 1300 || l.units !== 15) fail("invoice line prices marginally");
if (total([l, line("widget", 10, tiers)]) !== 2300) fail("invoice total sums lines");

console.log("PASS: only the units inside a tier pay that tier's price");
