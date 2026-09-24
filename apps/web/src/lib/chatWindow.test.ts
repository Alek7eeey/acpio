import { describe, expect, it } from "vitest";
import {
  chatMessageWindow,
  chatWindowNeedsSlide,
  chatWindowTargetPx,
  CHAT_WINDOW_VIEWPORTS,
} from "./chatWindow.js";

const flat = (count: number, height = 100) => Array.from({ length: count }, () => height);
const sum = (heights: number[], from: number, to: number) =>
  heights.slice(from, to).reduce((acc, h) => acc + h, 0);

describe("chatMessageWindow", () => {
  it("covers the visible range and grows to the target height", () => {
    const heights = flat(80);
    const win = chatMessageWindow({ heights, firstVisible: 40, lastVisible: 43, targetPx: 2000 });

    const height = sum(heights, win.from, win.to);
    expect(win.from).toBeLessThanOrEqual(40);
    expect(win.to).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(2000);
    expect(height).toBeLessThan(2200);
  });

  it("keeps the height steady across slides, which is what holds the thumb", () => {
    const heights = flat(120);
    const heightsSeen = [30, 60, 90].map((first) => {
      const win = chatMessageWindow({ heights, firstVisible: first, lastVisible: first + 2, targetPx: 2000 });
      return sum(heights, win.from, win.to);
    });

    expect(new Set(heightsSeen).size).toBe(1);
  });

  it("prefers the candidate nearer the target when a message overshoots it", () => {
    // Rows of 100 with a single 900px row in the way: short of the target (1800)
    // beats overshooting it (2800, then further).
    const heights = [900, ...flat(40)];
    const win = chatMessageWindow({ heights, firstVisible: 6, lastVisible: 9, targetPx: 2000 });
    const height = sum(heights, win.from, win.to);

    expect(Math.abs(height - 2000)).toBeLessThan(Math.abs(height + 900 - 2000));
  });

  it("does not grow past the target when one message already exceeds it", () => {
    const heights = [100, 100, 5000, 100, 100];
    const win = chatMessageWindow({ heights, firstVisible: 2, lastVisible: 2, targetPx: 1500 });

    expect(win).toEqual({ from: 2, to: 3 });
  });

  it("stops growing at the end of the session instead of taking the whole chat", () => {
    const heights = flat(200);
    const win = chatMessageWindow({ heights, firstVisible: 197, lastVisible: 199, targetPx: 2000 });

    expect(win.to).toBe(200);
    expect(win.to - win.from).toBeLessThan(30);
  });

  it("stops at the ends of the session", () => {
    const heights = flat(6);
    const win = chatMessageWindow({ heights, firstVisible: 0, lastVisible: 0, targetPx: 10000 });

    expect(win).toEqual({ from: 0, to: 6 });
  });

  it("returns an empty window for an empty chat", () => {
    expect(chatMessageWindow({ heights: [], firstVisible: 0, lastVisible: 0, targetPx: 2000 })).toEqual({
      from: 0,
      to: 0,
    });
  });
});

describe("chatWindowNeedsSlide", () => {
  const viewport = 800;
  const heights = flat(60);

  it("slides when the reader approaches a mounted edge", () => {
    const win = { from: 30, to: 45 };
    // 100px of context left above, less than half a viewport.
    expect(
      chatWindowNeedsSlide({ heights, window: win, firstVisible: 31, lastVisible: 35, viewportPx: viewport }),
    ).toBe(true);
  });

  it("stays put right after a slide", () => {
    // Both sides hold well over half a viewport of context.
    const win = { from: 22, to: 47 };
    expect(
      chatWindowNeedsSlide({ heights, window: win, firstVisible: 30, lastVisible: 34, viewportPx: viewport }),
    ).toBe(false);
  });

  it("does nothing without a viewport or a window", () => {
    expect(
      chatWindowNeedsSlide({ heights, window: { from: 0, to: 1 }, firstVisible: 0, lastVisible: 0, viewportPx: 0 }),
    ).toBe(false);
    expect(chatWindowTargetPx(0)).toBe(0);
  });
});

describe("chatWindowTargetPx", () => {
  it("aims for a few viewports of history", () => {
    expect(chatWindowTargetPx(700)).toBe(700 * CHAT_WINDOW_VIEWPORTS);
  });
});
