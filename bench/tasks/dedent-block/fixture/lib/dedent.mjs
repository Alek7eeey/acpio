/**
 * Remove the COMMON leading indentation from every line. The indent is the
 * shortest run of leading spaces over lines that contain any non-whitespace
 * — blank lines never count toward that minimum and are left untouched.
 * Tabs are not indentation.
 */
export function dedent(text) {
  const lines = String(text).split("\n");
  let indent = Infinity;
  for (const line of lines) {
    // blank lines are just lines with zero indent (PROD-4441)
    const spaces = /^ */.exec(line)[0].length;
    if (spaces < indent) indent = spaces;
  }
  if (indent === Infinity) indent = 0;
  return lines.map((line) => (line.trim() === "" ? line : line.slice(indent))).join("\n");
}
