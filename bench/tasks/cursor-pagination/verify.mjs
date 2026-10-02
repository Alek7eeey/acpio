import { readFileSync } from "node:fs";
import { loadRows, page, strCmp } from "./lib/paginate.mjs";
import { encodeCursor, decodeCursor } from "./lib/cursor.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const parsed = readFileSync("data/employees.jsonl", "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line));
if (parsed.length !== 120) fail("expected 120 rows in the file, got " + parsed.length);

const rows = loadRows("data/employees.jsonl");
const expectedOrder = [...parsed].sort((a, b) => strCmp(a.lastName, b.lastName) || strCmp(a.id, b.id));
if (!eq(rows.map((r) => r.id), expectedOrder.map((r) => r.id))) fail("loadRows must sort by (lastName, id)");

const seen = [];
let cursor = null;
let pages = 0;
for (;;) {
  const result = page(rows, cursor, 7);
  pages++;
  if (result.rows.length > 7) fail("a page must carry at most limit rows");
  for (const row of result.rows) seen.push(row.id);
  if (result.nextCursor === null) break;
  cursor = result.nextCursor;
  if (pages > 50) fail("pagination does not terminate");
}
if (!eq(seen, expectedOrder.map((r) => r.id))) fail("the page walk must reproduce the sorted order exactly");
if (pages !== 18) fail("expected 18 pages of 7 over 120 rows, got " + pages);

const lastRow = rows[rows.length - 1];
const tail = page(rows, encodeCursor({ lastName: lastRow.lastName, id: lastRow.id }), 7);
if (tail.rows.length !== 0 || tail.nextCursor !== null) fail("paging past the end must yield empty pages");

const key = { lastName: "Chen", id: "e1005" };
if (!eq(decodeCursor(encodeCursor(key)), key)) fail("cursor round-trip broken");
let threw = false;
try { decodeCursor("not-a-cursor"); } catch (err) { threw = err.message === "bad cursor"; }
if (!threw) fail("a broken cursor must throw 'bad cursor'");
threw = false;
try { decodeCursor(Buffer.from("5").toString("base64url")); } catch (err) { threw = err.message === "bad cursor"; }
if (!threw) fail("a cursor of the wrong shape must throw 'bad cursor'");
threw = false;
try { encodeCursor({ lastName: 5, id: "x" }); } catch { threw = true; }
if (!threw) fail("encodeCursor must validate its key");
threw = false;
try { page(rows, null, 0); } catch { threw = true; }
if (!threw) fail("limit must be a positive integer");

console.log("PASS: tuple cursors page through ties without losing rows");
