import { parseHeadings } from "./md-parse.mjs";

/** GitHub-ish slug: lowercase, non-alphanumerics to '-', trimmed. */
export function slugifyHeading(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * TOC: one "- [title](#slug)" per heading, 2 spaces of indent per level-1,
 * duplicate slugs get -2, -3, ... in document order.
 */
export function buildToc(markdown) {
  const seen = new Map();
  const lines = [];
  for (const heading of parseHeadings(markdown)) {
    const base = slugifyHeading(heading.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const slug = n === 1 ? base : base + "-" + n;
    lines.push("  ".repeat(heading.level - 1) + "- [" + heading.text + "](#" + slug + ")");
  }
  return lines.join("\n");
}
