/**
 * Greedy word wrap at `width` columns. Words are never broken; a word longer
 * than `width` occupies a line of its own. "\n" in the input is a hard
 * break; runs of spaces collapse; no trailing spaces.
 */
export function wrap(text, width) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("width must be a positive integer");
  }
  return String(text)
    .split("\n")
    .map((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      const lines = [];
      let current = "";
      for (const word of words) {
        if (current === "") {
          current = word;
        } else if (current.length + 1 + word.length < width) {
          current += " " + word;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current !== "") lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}
