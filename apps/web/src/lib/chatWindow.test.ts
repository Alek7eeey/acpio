import { describe, expect, it } from "vitest";
import {
  chatMessageWindow,
  chatWindowNeedsSlide,
  chatWindowSidePx,
  CHAT_WINDOW_MIN_SIDE,
} from "./chatWindow.js";

const flat = (count: number, height = 100) => Array.from({ length: count }, () => height);

describe("chatMessageWindow", () => {
  it("covers the visible range and reaches the context budget on both sides", () => {
    const heights = flat(50);
    // 5 visible rows (indexes 20..24) and 250px of context each way: 100px rows,
    // so the window reaches one row past the budget.
    const win = chatMessageWindow({
      heights,
      firstVisible: 20,
      lastVisible: 24,
      sidePx: 250,
      minSide: CHAT_WINDOW_MIN_SIDE,
    });

    expect(win).toEqual({ from: 17, to: 28 });
  });

  it("keeps a couple of neighbours even when the context budget is tiny", () => {
    const win = chatMessageWindow({
      heights: flat(50),
      firstVisible: 30,
      lastVisible: 30,
      sidePx: 0,
      minSide: CHAT_WINDOW_MIN_SIDE,
    });

    expect(win).toEqual({ from: 28, to: 33 });
  });

  it("never runs past the ends of the session", () => {
    const first = chatMessageWindow({
      heights: flat(10),
      firstVisible: 0,
      lastVisible: 1,
      sidePx: 1000,
      minSide: 2,
    });
    const last = chatMessageWindow({
      heights: flat(10),
      firstVisible: 8,
      lastVisible: 9,
      sidePx: 1000,
      minSide: 2,
    });

    expect(first).toEqual({ from: 0, to: 10 });
    expect(last).toEqual({ from: 0, to: 10 });
  });

  it("counts a message taller than the budget as a single step", () => {
    // A 9000px neighbour is one step of context, not a reason to drop it (or to
    // reach further): the window stops at it.
    const heights = [100, 9000, 100, 100, 100];
    const win = chatMessageWindow({
      heights,
      firstVisible: 2,
      lastVisible: 2,
      sidePx: 150,
      minSide: 0,
    });

    expect(win).toEqual({ from: 1, to: 5 });
  });

  it("returns an empty window for an empty chat", () => {
    expect(chatMessageWindow({ heights: [], firstVisible: 0, lastVisible: 0, sidePx: 500, minSide: 2 })).toEqual({
      from: 0,
      to: 0,
    });
  });
});

describe("chatWindowNeedsSlide", () => {
  const viewport = 800;
  const heights = flat(60);

  it("slides when the reader approaches the mounted edge", () => {
    // One row of context left above (100px < 0.25 viewport): mount the next stretch.
    const win = { from: 30, to: 40 };
    expect(
      chatWindowNeedsSlide({ heights, window: win, firstVisible: 31, lastVisible: 34, viewportPx: viewport }),
    ).toBe(true);
  });

  it("stays put while the reader is inside the mounted context", () => {
    // 300px of context above and 500px below: inside the band, nothing to do.
    const win = { from: 23, to: 36 };
    expect(
      chatWindowNeedsSlide({ heights, window: win, firstVisible: 26, lastVisible: 30, viewportPx: viewport }),
    ).toBe(false);
  });

  it("trims when the reader has drifted deep into the mounted context", () => {
    const win = { from: 10, to: 40 };
    expect(
      chatWindowNeedsSlide({ heights, window: win, firstVisible: 25, lastVisible: 29, viewportPx: viewport }),
    ).toBe(true);
  });

  it("does nothing without a viewport or a window", () => {
    expect(
      chatWindowNeedsSlide({ heights, window: { from: 0, to: 1 }, firstVisible: 0, lastVisible: 0, viewportPx: 0 }),
    ).toBe(false);
    expect(chatWindowSidePx(0)).toBe(0);
  });
});
