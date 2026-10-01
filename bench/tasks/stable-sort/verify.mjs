import { sortBy } from "./lib/sortlib.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = [{ v: 2 }, { v: 10 }, { v: 1 }];
const sorted = sortBy(rows, "v");
if (sorted.map((r) => r.v).join(",") !== "1,2,10") fail("numeric sort broken: " + sorted.map((r) => r.v));
if (rows.map((r) => r.v).join(",") !== "2,10,1") fail("input array was mutated");

const desc = sortBy(rows, "v", { desc: true });
if (desc.map((r) => r.v).join(",") !== "10,2,1") fail("desc broken: " + desc.map((r) => r.v));

const names = [{ n: "banana" }, { n: "Apple" }, { n: "cherry" }];
const byName = sortBy(names, "n");
if (byName.map((r) => r.n).join(",") !== "Apple,banana,cherry") fail("string sort broken: " + byName.map((r) => r.n));

const ties = [{ k: "x", i: 1 }, { k: "x", i: 2 }, { k: "x", i: 3 }];
const stable = sortBy(ties, "k");
if (stable.map((r) => r.i).join(",") !== "1,2,3") fail("ties must keep input order");

console.log("PASS: numeric compare, desc, non-mutating, stable ties");
