/**
 * Which way a diff is laid out — two columns, or one with the changes inside the
 * text. One preference for the app: the code pane's diff tab and the diff the
 * git panel embeds read and write the same key, so picking a layout in one
 * place does not look forgotten in the other.
 *
 * A change reads in one column until the reader says otherwise: the patch and
 * the file are then one page, the way a commit is read in a terminal or on
 * GitHub, and the columns are a press away.
 */
export type DiffMode = "split" | "inline";

const DIFF_MODE_KEY = "acpio.diffMode.v1";

export function readDiffMode(): DiffMode {
  try {
    const stored = localStorage.getItem(DIFF_MODE_KEY);
    if (stored === "split" || stored === "inline") return stored;
  } catch {
    // No storage: the default still holds.
  }
  return "inline";
}

export function writeDiffMode(mode: DiffMode): void {
  try {
    localStorage.setItem(DIFF_MODE_KEY, mode);
  } catch {
    // A full quota costs the preference, not the diff.
  }
}
