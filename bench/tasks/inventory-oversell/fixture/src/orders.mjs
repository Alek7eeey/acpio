/**
 * Orders reserve stock line by line. An order is all-or-nothing: if any
 * line cannot be reserved, the lines already reserved for THIS order are
 * released again and the error propagates.
 */
export function placeOrder(stock, { id, lines }) {
  if (!id) throw new Error("order id required");
  try {
    for (const line of lines) {
      stock.reserve(line.sku, line.qty, id);
    }
  } catch (err) {
    stock.release(id);
    throw err;
  }
  return { id, lines: lines.map((l) => ({ ...l })) };
}
