/**
 * RFC 4180 writer. A field is quoted only when it contains a comma, a
 * double-quote, CR or LF; quotes inside are DOUBLED — every one of them.
 * Rows are joined with CRLF; null/undefined become empty fields.
 */
export function encodeCsv(rows) {
  return rows.map((row) => row.map(encodeField).join(",")).join("\r\n");
}

function encodeField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace('"', '""') + '"' : s; // first quote only
}
