/**
 * The rule both fields keep for a pasted wall of text — the chat's composer
 * and the board's task description: it is offered as a file instead of
 * swamping the field. Anything shorter is pasted by the browser itself, as it
 * always was.
 */
const PASTE_AS_FILE_MIN_CHARS = 1500;
const PASTE_AS_FILE_MIN_LINES = 20;

export function isLargePastedText(text: string): boolean {
  return (
    text.length >= PASTE_AS_FILE_MIN_CHARS || text.split("\n").length >= PASTE_AS_FILE_MIN_LINES
  );
}

/**
 * Name of the file a pasted block becomes. Millisecond precision on purpose:
 * the link written into the field carries this name, so a second paste in the
 * same second must not land on the name an earlier one already took (the
 * server would then rename the file and the link would point at nothing).
 */
export function pastedTextFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  return `pasted-text-${stamp}.txt`;
}

/** Put a block back into the field's text over the range the paste replaced.
 *  A range known to be gone (no offer recorded) appends instead. */
export function spliceComposerText(
  base: string,
  insertion: string,
  at: { start: number; end: number } | null,
): string {
  if (!at) return base + insertion;
  const start = Math.min(Math.max(at.start, 0), base.length);
  const end = Math.min(Math.max(at.end, start), base.length);
  return base.slice(0, start) + insertion + base.slice(end);
}
