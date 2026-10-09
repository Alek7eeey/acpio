export function titleCase(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function wordCount(text) {
  return titleCase(text).split(" ").filter((w) => w.length > 0).length;
}
