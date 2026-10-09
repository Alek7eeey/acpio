import { describe, it, expect } from "vitest";
import { planReasoningCollapseScroll } from "./reasoningCollapseScroll";

/** Scrollport of the chat thread on a phone, in viewport coordinates. */
const THREAD = { viewportTop: 52, viewportBottom: 647 };
/** Block header scrolled above the scrollport: the reader is inside the body. */
const HEADER_ABOVE = 40;

describe("planReasoningCollapseScroll", () => {
  it("holds the place of the reply when it is on screen", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: HEADER_ABOVE, nextTop: 400 }),
    ).toEqual({ kind: "hold", anchor: "next", offset: 348 });
  });

  it("holds the place of content that is only partly visible at the bottom", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: HEADER_ABOVE, nextTop: 646 }),
    ).toEqual({ kind: "hold", anchor: "next", offset: 594 });
  });

  it("prefers the reply over the header when both are on screen", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 560, nextTop: 400 }),
    ).toEqual({ kind: "hold", anchor: "next", offset: 348 });
  });

  it("holds the header when the reply is below the fold but the header is on screen", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 300, nextTop: 900 }),
    ).toEqual({ kind: "hold", anchor: "block", offset: 248 });
  });

  it("holds the header when nothing follows the block", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 300, nextTop: null }),
    ).toEqual({ kind: "hold", anchor: "block", offset: 248 });
  });

  it("holds the header when the next content sits above the scrollport", () => {
    // Measured live: header 150px into the scrollport, the next message row
    // reported at y=0 (its own wrapper is pinned), so neither "next" rule fits.
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 202, nextTop: 0 }),
    ).toEqual({ kind: "hold", anchor: "block", offset: 150 });
  });

  it("lands on the block when the reply starts below the fold", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: HEADER_ABOVE, nextTop: 900 }),
    ).toEqual({ kind: "align" });
  });

  it("lands on the block when the reply starts exactly at the fold", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: HEADER_ABOVE, nextTop: 647 }),
    ).toEqual({ kind: "align" });
  });

  it("lands on the block when the reply scrolled past above", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: HEADER_ABOVE, nextTop: 10 }),
    ).toEqual({ kind: "align" });
  });

  it("lands on the block when neither it nor the reply is on screen", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 900, nextTop: 1200 }),
    ).toEqual({ kind: "align" });
  });

  it("lands on the block when its header sits exactly at the fold", () => {
    expect(
      planReasoningCollapseScroll({ ...THREAD, blockTop: 647, nextTop: null }),
    ).toEqual({ kind: "align" });
  });
});
