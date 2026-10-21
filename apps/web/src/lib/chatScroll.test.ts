import { describe, expect, it } from "vitest";
import {
  STICK_ECHO_MS,
  followsThreadBottom,
  showsJumpToLatest,
  threadScrollRearmsBottom,
  type ThreadScrollMetrics,
} from "./chatScroll.js";

/** A 900px scrollport over a 5000px thread, scrolled to the very bottom. */
function atBottom(overrides: Partial<ThreadScrollMetrics> = {}): ThreadScrollMetrics {
  const clientHeight = overrides.clientHeight ?? 900;
  const scrollHeight = overrides.scrollHeight ?? 5000;
  const scrollTop = scrollHeight - clientHeight;
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    prevScrollTop: overrides.prevScrollTop ?? scrollTop,
  };
}

/** The same scrollport, `hiddenPx` pixels of the thread left below the fold. */
function withHidden(hiddenPx: number, overrides: Partial<ThreadScrollMetrics> = {}): ThreadScrollMetrics {
  const base = atBottom(overrides);
  return { ...base, scrollTop: base.scrollTop - hiddenPx };
}

describe("followsThreadBottom", () => {
  it("holds while the reader is at the bottom and the thread grows", () => {
    // Growth does not move scrollTop; the pin has to survive it.
    expect(followsThreadBottom(atBottom())).toBe(true);
    expect(followsThreadBottom(atBottom({ scrollHeight: 6000 }))).toBe(true);
  });

  it("yields from the third pixel of an upward scroll", () => {
    // A slow phone drag moved 3px per event and never reached the old 140px
    // gate, so the next token pulled the reader back down. Two pixels are
    // layout noise, not the reader.
    const bottom = atBottom();
    expect(followsThreadBottom({ ...bottom, scrollTop: bottom.scrollTop - 2 })).toBe(true);
    expect(followsThreadBottom({ ...bottom, scrollTop: bottom.scrollTop - 3 })).toBe(false);
  });

  it("stays released while the reader keeps scrolling up", () => {
    const bottom = atBottom();
    expect(
      followsThreadBottom({
        ...bottom,
        scrollTop: bottom.scrollTop - 400,
        prevScrollTop: bottom.scrollTop - 300,
      }),
    ).toBe(false);
  });

  it("re-engages only once the reader is near the bottom again", () => {
    const bottom = atBottom();
    expect(
      followsThreadBottom({
        ...bottom,
        scrollTop: bottom.scrollTop - 100,
        prevScrollTop: bottom.scrollTop - 300,
      }),
    ).toBe(true);
    expect(
      followsThreadBottom({
        ...bottom,
        scrollTop: bottom.scrollTop - 400,
        prevScrollTop: bottom.scrollTop - 500,
      }),
    ).toBe(false);
  });
});

describe("threadScrollRearmsBottom", () => {
  it("discards a bottom-landing scroll inside the echo window", () => {
    // The reader left the bottom by wheel while the reply was streaming: the
    // token that followed pulled the viewport down and left a scroll event at
    // the bottom. The plain rule re-arms the pin on it (that is the unfixed
    // behavior) and the reader is dragged back mid-drag.
    const bottom = atBottom();
    expect(followsThreadBottom(bottom)).toBe(true);
    expect(threadScrollRearmsBottom(bottom, 1000, 1000 + STICK_ECHO_MS)).toBe(false);
    expect(threadScrollRearmsBottom(bottom, 1000 + STICK_ECHO_MS - 1, 1000 + STICK_ECHO_MS)).toBe(false);
  });

  it("holds through a drag longer than one window", () => {
    // A reader dragging slowly upward sends an upward step every ~200ms. The
    // window is re-armed by each step, so the growth never gets the pin back in
    // the middle of the drag — no matter how long the drag lasts.
    const bottom = atBottom();
    let echoUntil = 0;
    for (let at = 0; at < 3000; at += 200) {
      echoUntil = at + STICK_ECHO_MS;
      expect(threadScrollRearmsBottom(bottom, at + 199, echoUntil)).toBe(false);
    }
    // The drag ends: the pin is handed back only once the reader stops.
    expect(threadScrollRearmsBottom(bottom, echoUntil, echoUntil)).toBe(true);
  });

  it("re-arms on any scroll once the window has passed", () => {
    const bottom = atBottom();
    const echoUntil = 1000 + STICK_ECHO_MS;
    expect(threadScrollRearmsBottom(bottom, echoUntil, echoUntil)).toBe(true);
    expect(threadScrollRearmsBottom(withHidden(300), echoUntil, echoUntil)).toBe(false);
  });

  it("stays released on scroll events with no window to hold", () => {
    expect(threadScrollRearmsBottom(withHidden(400), 1000, 0)).toBe(false);
  });
});

describe("showsJumpToLatest", () => {
  it("stays hidden while the thread is on screen", () => {
    expect(showsJumpToLatest(atBottom())).toBe(false);
    // Mid-layout reading: the thread is shorter than the scrollport.
    expect(showsJumpToLatest({ scrollTop: 0, prevScrollTop: 0, scrollHeight: 200, clientHeight: 900 })).toBe(false);
  });

  it("stays hidden through a nudge off the bottom", () => {
    // The reported case: a few pixels of scroll, the last message still whole.
    expect(showsJumpToLatest(withHidden(20))).toBe(false);
    expect(showsJumpToLatest(withHidden(179))).toBe(false);
  });

  it("waits for a slice of a normal scrollport", () => {
    // 900px: a third is 300px, past the 180px floor.
    expect(showsJumpToLatest(withHidden(299))).toBe(false);
    expect(showsJumpToLatest(withHidden(300))).toBe(true);
  });

  it("holds the floor on a short scrollport", () => {
    // 300px: a third is 100px, so the floor decides.
    expect(showsJumpToLatest(withHidden(179, { clientHeight: 300 }))).toBe(false);
    expect(showsJumpToLatest(withHidden(180, { clientHeight: 300 }))).toBe(true);
  });

  it("ignores the direction of the scroll", () => {
    // Returning to the bottom hides the pill again: it answers "is something
    // out of sight", not "did the reader scroll up".
    expect(showsJumpToLatest(withHidden(600))).toBe(true);
    const bottom = atBottom();
    expect(showsJumpToLatest({ ...bottom, prevScrollTop: bottom.scrollTop - 600 })).toBe(false);
  });
});
