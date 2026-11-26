/**
 * Which way a diff is laid out — two columns, or one with the changes inside the
 * text. One preference for the app: the code pane's diff tab and the diff the
 * git panel embeds read and write the same key, so picking a layout in one
 * place does not look forgotten in the other.
 */
export type DiffMode = "split" | "inline";

const DIFF_MODE_KEY = "acpio.diffMode.v1";

export function readDiffMode(): DiffMode {
  try {
    return localStorage.getItem(DIFF_MODE_KEY) === "inline" ? "inline" : "split";
  } catch {
    return "split";
  }
}

export function writeDiffMode(mode: DiffMode): void {
  try {
    localStorage.setItem(DIFF_MODE_KEY, mode);
  } catch {
    // A full quota costs the preference, not the diff.
  }
}
