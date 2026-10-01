export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  // Math.floor keeps odd lengths on the true middle index (Math.round would
  // round up, e.g. Math.round(1.5) === 2, reading past the middle).
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
