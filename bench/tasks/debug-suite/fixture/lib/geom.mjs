export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.round(sorted.length / 2);
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
