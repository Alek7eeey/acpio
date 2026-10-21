/**
 * When the chat thread follows its own growth, and when the "jump to latest"
 * pill is worth showing.
 *
 * The two questions used to be one: the pin was released and the pill appeared
 * on the same condition, so *any* upward scroll raised it. A reader nudging the
 * thread up by a few pixels therefore got a pill over a last message that was
 * still entirely on screen. They are separate concerns:
 *
 *  - the pin answers "should the next token pull the viewport down?" — it has to
 *    yield on the first upward movement, or a slow drag never escapes it;
 *  - the pill answers "is something out of sight?" — that only becomes true once
 *    a real slice of the thread is hidden, so it waits.
 */
export type ThreadScrollMetrics = {
  scrollTop: number;
  /** Offset before this event, for telling the reader's drag from growth. */
  prevScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Upward movement below this is layout noise, not the reader taking over. */
const SCROLLED_UP_MIN_PX = 2;
/** Hidden content that still counts as "at the bottom". */
const FOLLOW_MAX_HIDDEN_PX = 140;
/** Floor for the pill, so a short scrollport does not raise it on a nudge. */
const JUMP_LATEST_MIN_HIDDEN_PX = 180;
/** Share of the scrollport that must be out of sight before the pill appears. */
const JUMP_LATEST_MIN_HIDDEN_RATIO = 1 / 3;

/**
 * Whether the next growth should pull the viewport back to the bottom. Any
 * upward scroll hands the thread to the reader: the old rule waited for a fixed
 * 140px gap, which a slow phone drag never covered — the next token grew the
 * thread and the pin pulled the reader back down, so only a hard fling escaped.
 */
export function followsThreadBottom(metrics: ThreadScrollMetrics) {
  const hiddenPx = Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
  return !scrollHandsThreadToReader(metrics) && hiddenPx < FOLLOW_MAX_HIDDEN_PX;
}

/**
 * Whether this scroll step is the reader taking the thread over. It is the one
 * moment the pin yields, and the one moment the echo window is armed — every
 * further step of the same drag re-arms it, so a slow drag stays covered for its
 * whole length rather than for its first half second.
 */
export function scrollHandsThreadToReader(metrics: ThreadScrollMetrics) {
  return metrics.scrollTop < metrics.prevScrollTop - SCROLLED_UP_MIN_PX;
}

/**
 * How long a scroll back to the bottom counts as the pin's own echo rather than
 * the reader returning. A wheel notch is reported before the scroll it causes,
 * and the thread keeps growing in between: the token that pulls the viewport
 * down leaves a scroll event sitting at the bottom, and re-arming the pin on it
 * is what makes the thread stick and jitter while the model answers. The window
 * is re-armed by each upward step, so it measures the pause at the end of a drag
 * and not the length of the drag itself.
 */
export const STICK_ECHO_MS = 500;

/**
 * Whether a scroll event hands the pin back to the bottom. Inside the echo
 * window after the reader's last upward step, a scroll that lands at the bottom
 * is that echo — the plain rule re-engages the pin on the pin's own output, and
 * the reader is dragged back mid-drag. The reader's own wheel down never comes
 * through here: it is read off the intent as it is made, so returning to the
 * bottom re-arms at once instead of waiting the window out.
 */
export function threadScrollRearmsBottom(
  metrics: ThreadScrollMetrics,
  now: number,
  echoUntil: number,
) {
  if (now < echoUntil) return false;
  return followsThreadBottom(metrics);
}

/**
 * Whether the pill belongs on screen. It exists for content the reader cannot
 * see, so it waits until a real slice of the scrollport is hidden: a nudge off
 * the bottom leaves the last message whole, and a pill floating over it covers
 * what the reader is looking at.
 */
export function showsJumpToLatest(metrics: ThreadScrollMetrics) {
  const hiddenPx = Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
  const minHiddenPx = Math.max(
    JUMP_LATEST_MIN_HIDDEN_PX,
    metrics.clientHeight * JUMP_LATEST_MIN_HIDDEN_RATIO,
  );
  return hiddenPx >= minHiddenPx;
}
