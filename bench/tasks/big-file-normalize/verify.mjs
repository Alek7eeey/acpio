// Hidden verifier: reconstructs the expected file from the spec rule and
// compares every line, so partial fixes or collateral damage both fail.

import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const raw = readFileSync("./users.ndjson", "utf8");
const lines = raw.split("\n").filter((l) => l.trim() !== "");
if (lines.length !== 3500) {
  fail(`users.ndjson has ${lines.length} data lines, expected 3500`);
}

const tlds = ["com", "net", "org"];
for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  let row;
  try {
    row = JSON.parse(lines[i]);
  } catch (err) {
    fail(`line ${n} is not JSON: ${String(err.message).split("\n")[0]}`);
  }
  if (row.id !== n) fail(`line ${n}: id is ${JSON.stringify(row.id)}, expected ${n}`);
  if (row.name !== `user${n}`) fail(`line ${n}: name is ${JSON.stringify(row.name)}, expected "user${n}"`);
  const expected = `user${n}@example.${tlds[n % 3]}`;
  if (row.email !== expected) {
    fail(`line ${n}: email is ${JSON.stringify(row.email)}, expected ${JSON.stringify(expected)}`);
  }
}

console.log("PASS: all 3500 lines match the spec — lowercase emails, ids and names untouched");
