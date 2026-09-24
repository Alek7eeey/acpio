/**
 * Geometry for the chat's own scrollbar.
 *
 * The native thumb is proportional to the scroll height, which a long chat
 * turns into a few pixels — impossible to grab. The chat draws its own track
 * over the whole history instead: the handle keeps a floor on its height (so it
 * stays usable however long the chat is) and reports the position in the whole
 * history, not in the slice currently mounted.
 */

/** The thumb never gets thinner than this, in px. */
export const SCROLL_THUMB_MIN_PX = 96;

export type ScrollThumb = {
  /** Height of the handle, in px. */
  height: number;
  /** Offset of the handle from the top of the track, in px. */
  top: number;
};

/**
 * Handle for a thread showing `clientHeight` of a `contentHeight`-tall history,
 * whose mounted slice starts `contentTop` px into that history and is scrolled
 * `scrollTop` px into itself.
 */
export function scrollThumb({
  contentTop,
  scrollTop,
  contentHeight,
  clientHeight,
  trackHeight,
  minThumb = SCROLL_THUMB_MIN_PX,
}: {
  contentTop: number;
  scrollTop: number;
  contentHeight: number;
  clientHeight: number;
  trackHeight: number;
  minThumb?: number;
}): ScrollThumb {
  if (trackHeight <= 0 || contentHeight <= 0) return { height: 0, top: 0 };
  const proportional = (clientHeight / contentHeight) * trackHeight;
  const height = Math.min(trackHeight, Math.max(minThumb, proportional));
  const travel = Math.max(0, trackHeight - height);
  const maxOffset = Math.max(1, contentHeight - clientHeight);
  if (travel <= 0) return { height, top: 0 };
  const progress = Math.min(1, Math.max(0, (contentTop + scrollTop) / maxOffset));
  return { height, top: progress * travel };
}

/** Offset into the history for a handle dragged so its top sits at `thumbTop`. */
export function scrollOffsetForThumb({
  thumbTop,
  contentHeight,
  clientHeight,
  trackHeight,
  thumbHeight,
}: {
  thumbTop: number;
  contentHeight: number;
  clientHeight: number;
  trackHeight: number;
  thumbHeight: number;
}): number {
  const travel = Math.max(0, trackHeight - thumbHeight);
  const maxOffset = Math.max(0, contentHeight - clientHeight);
  if (travel <= 0 || maxOffset <= 0) return 0;
  const progress = Math.min(1, Math.max(0, thumbTop / travel));
  return progress * maxOffset;
}
