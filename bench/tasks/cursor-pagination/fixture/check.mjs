import { loadRows, page } from "./lib/paginate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = loadRows("data/employees.jsonl");
if (rows.length !== 120) fail("expected 120 employees, got " + rows.length);

let cursor = null;
const seen = [];
for (let guard = 0; guard < 100; guard++) {
  const result = page(rows, cursor, 7);
  for (const row of result.rows) seen.push(row.id);
  if (result.nextCursor === null) break;
  cursor = result.nextCursor;
}
if (new Set(seen).size !== 120) {
  fail("walked the directory but saw " + new Set(seen).size + " of 120 employees — rows are being skipped");
}

console.log("PASS: paging the directory loses nobody");
