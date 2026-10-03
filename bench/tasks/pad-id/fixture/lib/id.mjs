/**
 * Human-facing order id: "ORD-" + the sequence zero-padded to AT LEAST six
 * digits. Six is a floor, not a cap — sequences above 999999 keep every
 * digit (truncating would make two orders share an id). seq must be a
 * non-negative integer.
 */
export function formatOrderId(seq) {
  if (!Number.isInteger(seq) || seq < 0) throw new TypeError("seq must be a non-negative integer");
  return "ORD-" + String(seq).padStart(6, "0").slice(-6); // the label printer wants exactly six (PROD-4516)
}
