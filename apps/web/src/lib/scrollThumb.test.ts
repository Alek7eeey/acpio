import { describe, expect, it } from "vitest";
import { scrollThumb, scrollOffsetForThumb, SCROLL_THUMB_MIN_PX } from "./scrollThumb.js";

describe("scrollThumb", () => {
  it("keeps the handle at the floor however long the history is", () => {
    const t = scrollThumb({
      contentTop: 0,
      scrollTop: 0,
      contentHeight: 120000,
      clientHeight: 700,
      trackHeight: 700,
    });

    expect(t.height).toBe(SCROLL_THUMB_MIN_PX);
  });

  it("uses the proportional height when the history is short", () => {
    const t = scrollThumb({
      contentTop: 0,
      scrollTop: 0,
      contentHeight: 1500,
      clientHeight: 700,
      trackHeight: 700,
    });

    expect(t.height).toBeCloseTo((700 / 1500) * 700);
  });

  it("reports the position in the whole history, not in the mounted slice", () => {
    const args = { contentHeight: 120000, clientHeight: 700, trackHeight: 700 };
    const travel = 700 - SCROLL_THUMB_MIN_PX;

    expect(scrollThumb({ ...args, contentTop: 0, scrollTop: 0 }).top).toBe(0);
    // Half way into a mounted slice that itself starts half way in.
    expect(scrollThumb({ ...args, contentTop: 60000, scrollTop: 0 }).top).toBeCloseTo(
      travel * (60000 / (120000 - 700)),
    );
    expect(scrollThumb({ ...args, contentTop: 119300, scrollTop: 0 }).top).toBeCloseTo(travel);
  });

  it("holds its size while the mounted slice changes", () => {
    const sizes = [0, 30000, 60000].map(
      (contentTop) =>
        scrollThumb({ contentTop, scrollTop: 0, contentHeight: 120000, clientHeight: 700, trackHeight: 700 })
          .height,
    );

    expect(new Set(sizes).size).toBe(1);
  });

  it("collapses without a track or content", () => {
    expect(
      scrollThumb({ contentTop: 0, scrollTop: 0, contentHeight: 0, clientHeight: 0, trackHeight: 0 }),
    ).toEqual({ height: 0, top: 0 });
  });
});

describe("scrollOffsetForThumb", () => {
  it("round-trips with scrollThumb", () => {
    const contentHeight = 120000;
    const clientHeight = 700;
    const trackHeight = 700;
    const thumb = scrollThumb({ contentTop: 42000, scrollTop: 0, contentHeight, clientHeight, trackHeight });
    const offset = scrollOffsetForThumb({
      thumbTop: thumb.top,
      contentHeight,
      clientHeight,
      trackHeight,
      thumbHeight: thumb.height,
    });

    expect(offset).toBeCloseTo(42000);
  });

  it("clamps a drag past the ends of the track", () => {
    const base = { contentHeight: 120000, clientHeight: 700, trackHeight: 700, thumbHeight: 96 };

    expect(scrollOffsetForThumb({ ...base, thumbTop: -50 })).toBe(0);
    expect(scrollOffsetForThumb({ ...base, thumbTop: 5000 })).toBe(120000 - 700);
  });
});
