/** Parse a patch: @@ -old,+new @@ headers with ' ' context, '-' del, '+' add lines. */
export function parsePatch(text) {
  const hunks = [];
  for (const m of text.matchAll(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n((?:[ +-][^\n]*\n?)+)/g)) {
    const lines = m[5].split("\n").filter((l) => l !== "");
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: Number(m[2]),
      newStart: Number(m[3]),
      newLines: Number(m[4]),
      changes: lines.map((l) => ({ kind: l[0], text: l.slice(1) })),
    });
  }
  return hunks;
}
