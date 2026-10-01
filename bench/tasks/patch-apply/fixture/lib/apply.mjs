import { parsePatch } from "./hunks.mjs";

/**
 * Apply hunks to an array of lines. Header positions are 1-based in the
 * ORIGINAL file; when an earlier hunk changes the line count, later hunks
 * follow the accumulated offset, and every hunk's old block must match the
 * source exactly before anything is replaced.
 */
export function applyPatch(sourceLines, patchText) {
  const hunks = parsePatch(patchText);
  const out = [...sourceLines];
  let offset = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1 + offset;
    const oldBlock = [];
    const newBlock = [];
    for (const change of hunk.changes) {
      if (change.kind === "+") {
        newBlock.push(change.text);
      } else if (change.kind === "-") {
        oldBlock.push(change.text);
      } else {
        oldBlock.push(change.text);
        newBlock.push(change.text);
      }
    }
    for (let i = 0; i < oldBlock.length; i++) {
      if (out[start + i] !== oldBlock[i]) {
        throw new Error(
          `context mismatch at line ${start + i + 1}: expected ${JSON.stringify(oldBlock[i])}, got ${JSON.stringify(out[start + i])}`,
        );
      }
    }
    out.splice(start, oldBlock.length, ...newBlock);
    // headers are absolute, nothing to accumulate
  }
  return out;
}
