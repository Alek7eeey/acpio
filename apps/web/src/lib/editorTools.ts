/** The tools the editor knows about, in the order the status bar lists them. */
export type EditorToolName = "typescript" | "oxlint" | "oxfmt";

/** The language TypeScript, oxlint and oxfmt are about. */
const TS_FAMILY = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
/** oxfmt formats what prettier did: code, data, styles, markup, prose. */
const FORMATTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|json5|css|scss|less|html|md|yaml|yml)$/i;

/**
 * The tools that have anything to say about this file: a C# or a `.txt` buffer
 * gets none, a JSON gets the formatter only.
 */
export function toolsForPath(file: string | null): EditorToolName[] {
  if (!file) return [];
  if (TS_FAMILY.test(file)) return ["typescript", "oxlint", "oxfmt"];
  return FORMATTABLE.test(file) ? ["oxfmt"] : [];
}
