/**
 * Line diff for the prompt lab: what a settings change added and what it took
 * away. Plain LCS, no dependency — the page and the test call the same code.
 *
 *   diffLines("a\nb", "a\nc") // [{op:"=",text:"a"},{op:"-",text:"b"},{op:"+",text:"c"}]
 */
/** An empty text is no lines at all, not one empty one. */
const linesOf = (text) => {
  const value = String(text ?? "");
  return value === "" ? [] : value.split("\n");
};

export function diffLines(before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  // A prompt is a few hundred lines, so the full table is cheaper than clever.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ op: "=", text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      rows.push({ op: "-", text: a[i] });
      i += 1;
    } else {
      rows.push({ op: "+", text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) rows.push({ op: "-", text: a[i] });
  for (; j < b.length; j += 1) rows.push({ op: "+", text: b[j] });
  return rows;
}

/** `{ added, removed }` line counts for a diff — what the step header shows. */
export function diffStats(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.op === "+") added += 1;
    else if (row.op === "-") removed += 1;
  }
  return { added, removed };
}
