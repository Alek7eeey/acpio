/**
 * stringcase v1 — stable, frozen. v1 semantics:
 * - camelCase(input, {keepAcronyms}): head word keeps its case only with the
 *   flag; every later word is capitalized.
 * - kebabCase(input): separators break words, every word lowercased whole.
 */
export function camelCase(input, { keepAcronyms = false } = {}) {
  const words = String(input).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "";
  const head = keepAcronyms ? words[0] : words[0].toLowerCase();
  return (
    head +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join("")
  );
}

export function kebabCase(input) {
  return String(input)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .join("-");
}
