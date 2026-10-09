/**
 * Where the reader lands after a reasoning block collapses.
 *
 * A reasoning body can be tens of thousands of pixels tall, so removing it
 * moves everything after it at once. Left to itself the browser answers by
 * clamping `scrollTop`, and the reader ends up somewhere unrelated to what
 * they were reading. Two outcomes are useful instead:
 *
 *  - the content after the block was on screen, so the reader had reached the
 *    block's tail — hold that content where it is, keeping the reader's place
 *    relative to the reply;
 *  - that content sat below the fold, but the block's own header was on screen
 *    — the reader is at the header, so hold the header where it is; a collapse
 *    must not scroll the transcript out from under them;
 *  - neither is on screen, so the reader was inside the body (or below it) —
 *    bring the collapsed block itself to the top of the scrollport.
 */
export type ReasoningCollapseScroll =
  /** Hold one of the block's neighbours at this offset from the scrollport top. */
  | { kind: "hold"; anchor: "block" | "next"; offset: number }
  /** Bring the collapsed block to the top of the scrollport. */
  | { kind: "align" };

/**
 * All offsets are viewport coordinates (`getBoundingClientRect`). `nextTop` is
 * the top edge of the first content after the collapsing block, or null when
 * nothing follows it in the thread.
 */
export function planReasoningCollapseScroll(input: {
  viewportTop: number;
  viewportBottom: number;
  blockTop: number;
  nextTop: number | null;
}): ReasoningCollapseScroll {
  const { viewportTop, viewportBottom, blockTop, nextTop } = input;
  if (nextTop !== null && nextTop > viewportTop && nextTop < viewportBottom) {
    return { kind: "hold", anchor: "next", offset: nextTop - viewportTop };
  }
  if (blockTop > viewportTop && blockTop < viewportBottom) {
    return { kind: "hold", anchor: "block", offset: blockTop - viewportTop };
  }
  return { kind: "align" };
}
