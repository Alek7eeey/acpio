export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || typeof patch !== "object") return patch;
  const baseIsObject = base !== null && typeof base === "object" && !Array.isArray(base);
  const out = baseIsObject ? base : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}
