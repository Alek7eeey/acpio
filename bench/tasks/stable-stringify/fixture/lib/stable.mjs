/**
 * Deterministic JSON: object keys are sorted RECURSIVELY (nested objects
 * too), arrays keep their order, scalars go through JSON.stringify. Two
 * deep-equal values must always produce the same string.
 */
export function stableStringify(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + JSON.stringify(value[key])); // leaves are already flat
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}
