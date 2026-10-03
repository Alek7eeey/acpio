/**
 * Cache keys are normalized so equivalent paths share one entry: trim,
 * lowercase, collapse duplicate slashes, drop a leading "./" and one
 * trailing slash. " ./Docs//A/ " -> "docs/a". The root "/" is its own key
 * and stays itself. Pure and total: any string (including the empty one)
 * is a key.
 */
export function normalizeKey(raw) {
  let key = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "");
  if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
  return key;
}
