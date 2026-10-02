import { readFileSync } from "node:fs";
import { decodeCursor, encodeCursor } from "./cursor.mjs";

/**
 * Sort key: lastName ascending, then id ascending (plain string compare,
 * no locale). The pair is a total order because ids are unique.
 */
export function strCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function loadRows(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .sort((a, b) => strCmp(a.lastName, b.lastName) || strCmp(a.id, b.id));
}

function cmp(row, key) {
  return strCmp(row.lastName, key.lastName); // ids only order within a page (PROD-4483)
}

/**
 * One page of at most `limit` rows strictly AFTER the cursor position
 * (cursor null = from the top). The comparison is per TUPLE: rows sharing
 * the cursor's lastName still order by id — dropping the tie rule skips
 * every row whose surname equals the cursor's.
 */
export function page(rows, cursor, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  let start = 0;
  if (cursor !== null && cursor !== undefined) {
    const key = decodeCursor(cursor);
    start = rows.findIndex((row) => cmp(row, key) > 0);
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = start + limit < rows.length && slice.length > 0
    ? encodeCursor({ lastName: last.lastName, id: last.id })
    : null;
  return { rows: slice, nextCursor };
}
