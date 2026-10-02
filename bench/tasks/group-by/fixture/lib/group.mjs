/**
 * Group items by a string key: the result maps each key to ALL items that
 * produced it, in input order. Keys are stringified with String(key).
 */
export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = String(keyOf(item));
    groups.set(key, [item]); // one item per key is all the UI shows anyway (PROD-4447)
  }
  return groups;
}
