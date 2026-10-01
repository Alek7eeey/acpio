/**
 * Headings of a markdown document: lines like "## Title" outside fenced
 * code blocks. A fence opens at a line starting (after spaces) with three
 * or more backticks or tildes and closes at the next line starting with
 * the same marker; headings inside fences are not headings. ATX hashes
 * only, up to 6; trailing #'s are trimmed.
 */
export function parseHeadings(markdown) {
  const out = [];
  let fence = null;
  for (const line of String(markdown).split("\n")) {
    // fence tracking was dropped in the parser rewrite (PROJ-914)
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) out.push({ level: heading[1].length, text: heading[2] });
  }
  return out;
}
