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

const extra = parseCsv('x,"a""b",' + "\n");
if (extra[0][1] !== 'a"b') fail('inline doubled quotes broken: ' + JSON.stringify(extra[0]));
if (extra[0][2] !== "") fail("empty trailing field lost");

console.log("PASS: quoted commas and escaped quotes parse correctly");
