import { readdirSync, readFileSync } from "node:fs";

const files = readdirSync(".").filter((f) => f.endsWith(".mjs") && f !== "verify.mjs");
const stale = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (/\bcalcTotal\b/.test(text)) stale.push(file);
}
if (stale.length) {
  console.error(`FAIL: old name calcTotal still present in ${stale.join(", ")}`);
  process.exit(1);
}

const a = readFileSync("a.mjs", "utf8");
if (!/\bcomputeTotal\b/.test(a)) {
  console.error("FAIL: a.mjs does not define computeTotal");
  process.exit(1);
}

const { orderTotal } = await import("./b.mjs");
const total = orderTotal({ items: [{ price: 2 }, { price: 3 }] });
if (total !== 5) {
  console.error(`FAIL: orderTotal = ${total}, expected 5`);
  process.exit(1);
}
console.log("PASS: symbol renamed and behaviour preserved");
