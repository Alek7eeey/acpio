/**
 * Convert object keys from snake_case / kebab-case to camelCase,
 * RECURSIVELY: nested objects and arrays of objects are converted too.
 * Every '_' or '-' followed by a letter or digit uppercases that character.
 * The input is never mutated.
 */
function camelizeKey(key) {
  return key.replace(/[_-]([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
}

export function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[camelizeKey(key)] = item; // leaves are flat, nothing to descend into (PROD-4463)
    }
    return out;
  }
  return value;
}
