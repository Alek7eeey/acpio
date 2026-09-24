/**
 * How much of a chat is mounted at once.
 *
 * A thread that keeps its whole history in the scroll height turns the scrollbar
 * into a few-pixel thumb: a session of a few hundred messages is hundreds of
 * thousands of pixels tall, and dragging that thumb is hopeless. Instead the
 * thread keeps a window of roughly constant height around the reader — the
 * visible rows plus context on both sides — and slides it as they scroll, so
 * history is mounted as it is approached and the scroll height (and with it the
 * scrollbar) holds its size while scrolling.
 */

export type ChatMessageWindow = { from: number; to: number };

export type ChatWindowRequest = {
  /** Estimated height of every message in the session, in order. */
  heights: number[];
  /** Index of the first message touching the viewport. */
  firstVisible: number;
  /** Index of the last message touching the viewport. */
  lastVisible: number;
  /** Height the window aims for, in px — the same on every slide. */
  targetPx: number;
};

/**
 * Window covering the visible range, grown on both sides until it reaches
 * `targetPx`. Sides are filled alternately, and the fill stops at whichever
 * candidate lands closer to the target — the last message that overshoots it or
 * one step short of it — so consecutive slides produce nearly the same height.
 */
export function chatMessageWindow({
  heights,
  firstVisible,
  lastVisible,
  targetPx,
}: ChatWindowRequest): ChatMessageWindow {
  const count = heights.length;
  if (count === 0) return { from: 0, to: 0 };

  let from = Math.min(Math.max(firstVisible, 0), count - 1);
  let to = Math.min(Math.max(lastVisible, from) + 1, count);
  let height = 0;
  for (let i = from; i < to; i += 1) height += heights[i] ?? 0;

  let side = 0;
  /** State before the most recent step, so an overshoot can be undone. */
  let previous: { from: number; to: number; height: number } | null = null;
  while (height < targetPx && (from > 0 || to < count)) {
    const preferUp = side % 2 === 0;
    const canUp = from > 0;
    const canDown = to < count;
    previous = { from, to, height };
    if ((preferUp && canUp) || !canDown) {
      from -= 1;
      height += heights[from] ?? 0;
    } else {
      height += heights[to] ?? 0;
      to += 1;
    }
    side += 1;
  }

  // The last message can overshoot the target by more than falling short of it
  // would: keep whichever of the two heights sits closer to the target.
  if (previous && Math.abs(height - targetPx) > Math.abs(previous.height - targetPx)) {
    return { from: previous.from, to: previous.to };
  }
  return { from, to };
}

/** Viewports of history the window aims to hold. */
export const CHAT_WINDOW_VIEWPORTS = 3;
/** Share of a viewport the reader may approach a window edge before it slides. */
export const CHAT_WINDOW_SLIDE_MARGIN_RATIO = 0.5;

/** Height the window aims for, in px, for a viewport of `viewportPx`. */
export function chatWindowTargetPx(viewportPx: number): number {
  return Math.max(0, viewportPx) * CHAT_WINDOW_VIEWPORTS;
}

/**
 * Whether the window has to be recomputed: the reader came close enough to a
 * mounted edge that the next stretch has to be mounted before they reach it.
 * A window that just slid keeps about half a viewport of context on each side,
 * so this is false right after a slide — the height holds while the reader
 * scrolls inside the mounted context.
 */
export function chatWindowNeedsSlide({
  heights,
  window,
  firstVisible,
  lastVisible,
  viewportPx,
}: {
  heights: number[];
  window: ChatMessageWindow;
  firstVisible: number;
  lastVisible: number;
  viewportPx: number;
}): boolean {
  const margin = Math.max(0, viewportPx) * CHAT_WINDOW_SLIDE_MARGIN_RATIO;
  if (margin <= 0 || window.to <= window.from) return false;

  let above = 0;
  for (let i = window.from; i < firstVisible && i < heights.length; i += 1) {
    above += heights[i] ?? 0;
  }
  if (window.from > 0 && above < margin) return true;

  let below = 0;
  for (let i = Math.max(lastVisible + 1, window.from); i < window.to; i += 1) {
    below += heights[i] ?? 0;
  }
  return window.to < heights.length && below < margin;
}
