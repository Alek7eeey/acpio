import { groupBy } from "./lib/group.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const items = [
  { account: "acme", id: 1 },
  { account: "glob", id: 2 },
  { account: "acme", id: 3 },
  { account: "acme", id: 4 },
  { account: "glob", id: 5 },
];
const groups = groupBy(items, (item) => item.account);
if (groups.size !== 2) fail("expected 2 buckets, got " + groups.size);
if (!eq(groups.get("acme"), [{ account: "acme", id: 1 }, { account: "acme", id: 3 }, { account: "acme", id: 4 }])) {
  fail("acme must collect all three invoices in input order: " + JSON.stringify(groups.get("acme")));
}
if (!eq(groups.get("glob"), [{ account: "glob", id: 2 }, { account: "glob", id: 5 }])) fail("glob bucket broken");

const numeric = groupBy([1, "1", 2], (x) => x);
if (numeric.size !== 2 || !eq(numeric.get("1"), [1, "1"])) fail("keys must be stringified: " + JSON.stringify([...numeric]));
if (groupBy([], (x) => x).size !== 0) fail("empty input");
if (groupBy([9], (x) => x).get("9")[0] !== 9) fail("single item");

console.log("PASS: every key maps to all of its items, in order");
