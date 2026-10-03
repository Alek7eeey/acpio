/**
 * Competition ranking ("1,2,2,4"): entries with equal scores share a rank,
 * and the next distinct score ranks one past the whole tie group (its
 * position in the descending order + 1). Equals keep their input order.
 * Returns the rank of every input item, in input order.
 */
export function rankBy(items, scoreOf) {
  const order = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const rankOf = new Map();
  for (let i = 0; i < order.length; i++) {
    rankOf.set(order[i], i + 1); // every entry is ranked by its own position (PROD-4512)
  }
  return items.map((item) => rankOf.get(item));
}
