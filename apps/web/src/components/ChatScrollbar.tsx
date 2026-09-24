import { useEffect, useRef, type RefObject } from "react";
import { useIsTouchUi } from "../lib/pointerUi";
import { scrollThumb, scrollOffsetForThumb } from "../lib/scrollThumb";
import styles from "./ChatScrollbar.module.css";

/** Hidden pixels below which the track is not worth drawing. */
const SCROLLABLE_MIN_PX = 8;

type ChatScrollbarProps = {
  /** The scrolling element the handle steers. */
  threadRef: RefObject<HTMLDivElement | null>;
  /** Top of the thread inside the chat column, in px. */
  top: number;
  /** Height of the thread's viewport, in px. */
  height: number;
  /** Estimated height of the whole history, in px. */
  contentHeight: number;
  /** Estimated height of everything above the mounted slice, in px. */
  contentTop: number;
  /** Bring the given offset of the history into view (may move the slice). */
  onSeek: (offset: number) => void;
};

/**
 * The chat's own scrollbar, over the thread's right edge.
 *
 * The native bar is proportional to the mounted scroll height, which is both
 * tiny in a long chat and changes whenever the mounted slice slides. This one
 * keeps a floor on the handle and reports the position in the whole history, so
 * its size holds still while scrolling and dragging it walks through the chat.
 *
 * Rendered for fine pointers only: touch devices scroll by gesture and keep the
 * platform's overlay bar. Decorative for assistive tech — the thread stays the
 * scroll target — so it is hidden from the accessibility tree.
 */
export function ChatScrollbar({
  threadRef,
  top,
  height,
  contentHeight,
  contentTop,
  onSeek,
}: ChatScrollbarProps) {
  const touch = useIsTouchUi();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  /** Pointer offset inside the handle while dragging; null for a track click. */
  const grabRef = useRef<number | null>(null);
  /** Latest history metrics, read by the (long-lived) scroll handler. */
  const metricsRef = useRef({ contentHeight, contentTop, onSeek });
  metricsRef.current = { contentHeight, contentTop, onSeek };

  // Position the handle straight in the DOM: scrolling fires dozens of times a
  // second, and re-rendering the whole chat page per frame is not worth it.
  useEffect(() => {
    if (touch) return undefined;
    const thread = threadRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!thread || !track || !thumb) return undefined;

    const sync = () => {
      const trackHeight = track.clientHeight;
      const metrics = metricsRef.current;
      // Without a window the thread holds the whole history, so its own scroll
      // height is the honest one; with a window only the estimate covers it.
      const content = metrics.contentHeight > 0 ? metrics.contentHeight : thread.scrollHeight;
      const topPx = metrics.contentHeight > 0 ? metrics.contentTop : 0;
      const maxScroll = content - thread.clientHeight;
      const scrollable = maxScroll > SCROLLABLE_MIN_PX && trackHeight > 0;
      track.dataset.scrollable = scrollable ? "true" : "false";
      if (!scrollable) return;
      const geometry = scrollThumb({
        contentTop: topPx,
        scrollTop: thread.scrollTop,
        contentHeight: content,
        clientHeight: thread.clientHeight,
        trackHeight,
      });
      thumb.style.height = `${geometry.height}px`;
      thumb.style.transform = `translateY(${geometry.top}px)`;
    };

    sync();
    thread.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    // The thread's box changes with the composer and the panels; its content
    // changes with every streamed token — and only the latter moves the thumb.
    ro?.observe(thread);
    if (thread.firstElementChild) ro?.observe(thread.firstElementChild);
    return () => {
      thread.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      ro?.disconnect();
    };
  }, [threadRef, touch, top, height, contentHeight, contentTop]);

  if (touch) return null;

  /** Walk the history so the handle sits under `clientY`. */
  const steer = (clientY: number) => {
    const thread = threadRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!thread || !track || !thumb) return;
    const trackRect = track.getBoundingClientRect();
    const thumbHeight = thumb.getBoundingClientRect().height;
    const grab = grabRef.current ?? thumbHeight / 2;
    const { contentHeight: content, onSeek: seek } = metricsRef.current;
    seek(
      scrollOffsetForThumb({
        thumbTop: clientY - trackRect.top - grab,
        contentHeight: content,
        clientHeight: thread.clientHeight,
        trackHeight: trackRect.height,
        thumbHeight,
      }),
    );
  };

  return (
    <div
      className={styles.track}
      style={{ top, height }}
      ref={trackRef}
      data-scrollable="false"
      aria-hidden="true"
      onPointerDown={(e) => {
        // Take the pointer so a drag that leaves the track (or the window) keeps
        // steering the handle, and the press does not select text in the thread.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const thumb = thumbRef.current;
        const thumbRect = thumb?.getBoundingClientRect();
        // Grabbing the handle keeps the pointer where it landed; clicking the
        // track jumps the handle under the pointer.
        grabRef.current =
          thumb && thumbRect && thumb.contains(e.target as Node) ? e.clientY - thumbRect.top : null;
        steer(e.clientY);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        steer(e.clientY);
      }}
      onPointerUp={(e) => {
        grabRef.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
    >
      <div className={styles.thumb} ref={thumbRef} />
    </div>
  );
}
