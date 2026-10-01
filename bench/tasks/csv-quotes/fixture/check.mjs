import { readFileSync } from "node:fs";
import { parseCsv } from "./lib/csv.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = parseCsv(readFileSync("sample.csv", "utf8"));
if (rows.length !== 3) fail("expected 3 rows, got " + rows.length);
const [a, b, c] = rows;
if (a.join("|") !== 'name|note') fail("header mismatch: " + a.join("|"));
if (b.join("|") !== 'ada|wrote "code", daily') fail('quoted comma broken: ' + b.join("|"));
if (c.join("|") !== 'bob|said "hi" twice') fail('doubled quote broken: ' + c.join("|"));
console.log("PASS: quoted commas and escaped quotes parse correctly");
