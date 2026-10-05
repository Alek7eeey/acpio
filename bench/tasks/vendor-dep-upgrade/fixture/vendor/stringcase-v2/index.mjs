/**
 * stringcase v2 — see README.md for the breaking changes from v1.
 */
export function camelCase(input, { preserveFirst = false } = {}) {
  const words = String(input).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "";
  const head = preserveFirst ? words[0] : words[0].toLowerCase();
  return (
    head +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
}

export function toKebab(input) {
  return String(input)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-");
}
