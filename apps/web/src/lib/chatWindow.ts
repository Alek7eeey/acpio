/**
 * How much of a chat is mounted at once.
 *
 * A thread that keeps its whole history in the scroll height turns the
 * scrollbar into a few-pixel thumb: a session of a few hundred messages is
 * hundreds of thousands of pixels tall, and dragging that thumb is hopeless.
 * Instead the thread keeps a window around the reader — the messages on screen
 * plus about one viewport of context on each side — and slides it as they
 * scroll, so the scrollbar stays a usable size and history arrives as it is
 * approached.
 */

export type ChatMessageWindow = { from: number; to: number };

export type ChatWindowRequest = {
  /** Estimated height of every message in the session, in order. */
  heights: number[];
  /** Index of the first message touching the viewport. */
  firstVisible: number;
  /** Index of the last message touching the viewport. */
  lastVisible: number;
  /** Context to keep beyond the viewport on each side, in px. */
  sidePx: number;
  /** Context to keep beyond the viewport on each side, in messages — a few
   *  short rows would otherwise leave the window with no room to scroll. */
  minSide: number;
};

/**
 * Window covering the visible range plus context, clamped to the session. A
 * message taller than the context budget still counts as one step, so a window
 * always holds at least the visible range and `minSide` neighbours.
 */
export function chatMessageWindow({
  heights,
  firstVisible,
  lastVisible,
  sidePx,
  minSide,
}: ChatWindowRequest): ChatMessageWindow {
  const count = heights.length;
  if (count === 0) return { from: 0, to: 0 };

  let from = Math.min(Math.max(firstVisible, 0), count - 1);
  let to = Math.min(Math.max(lastVisible, from) + 1, count);

  let above = 0;
  let aboveCount = 0;
  while (from > 0 && (above < sidePx || aboveCount < minSide)) {
    from -= 1;
    above += heights[from] ?? 0;
    aboveCount += 1;
  }

  let below = 0;
  let belowCount = 0;
  while (to < count && (below < sidePx || belowCount < minSide)) {
    below += heights[to] ?? 0;
    to += 1;
    belowCount += 1;
  }

  return { from, to };
}

/** Context kept above/below the viewport once a window has settled, in px. */
export const CHAT_WINDOW_SIDE_PX_RATIO = 0.75;
/** Messages kept above/below the viewport regardless of their height. */
export const CHAT_WINDOW_MIN_SIDE = 2;
/** Share of a viewport the reader may approach a window edge before it slides. */
export const CHAT_WINDOW_TRIGGER_RATIO = 0.25;
/** Share of a viewport beyond which the context on a side is trimmed back. */
export const CHAT_WINDOW_KEEP_RATIO = 1;

/** Context to keep on each side, in px, for a viewport of `viewportPx`. */
export function chatWindowSidePx(viewportPx: number): number {
  return Math.max(0, viewportPx) * CHAT_WINDOW_SIDE_PX_RATIO;
}

/**
 * Whether the window has to be recomputed: the reader came close to an edge (the
 * next stretch has to be mounted before they reach it) or drifted so far into
 * the middle that the context on a side is worth trimming back.
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
  const side = chatWindowSidePx(viewportPx);
  const trigger = side * CHAT_WINDOW_TRIGGER_RATIO;
  const keep = side * CHAT_WINDOW_KEEP_RATIO;
  if (side <= 0) return false;
  if (window.to <= window.from) return true;

  let above = 0;
  for (let i = window.from; i < firstVisible && i < heights.length; i += 1) {
    above += heights[i] ?? 0;
  }
  if (window.from > 0 && above < trigger) return true;
  if (above > keep) return true;

  let below = 0;
  for (let i = Math.max(lastVisible + 1, window.from); i < window.to; i += 1) {
    below += heights[i] ?? 0;
  }
  if (window.to < heights.length && below < trigger) return true;
  if (below > keep) return true;

  return false;
}
