// @vitest-environment jsdom
// A diff in two columns is read as one document: panning either half moves the
// other. jsdom has no layout, so the elements below are given a real scrollTop
// that fires a scroll event as the browser does after an assignment.

import { describe, expect, it } from "vitest";
import { syncMergeScroll } from "./mergeScrollSync";

function scroller() {
  const el = document.createElement("div");
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = value;
      el.dispatchEvent(new Event("scroll"));
    },
  });
  return el;
}

describe("syncMergeScroll", () => {
  it("moves the other half when one is panned", () => {
    const a = scroller();
    const b = scroller();
    const stop = syncMergeScroll(a, b);

    a.scrollTop = 120;
    expect(b.scrollTop).toBe(120);

    b.scrollTop = 40;
    expect(a.scrollTop).toBe(40);
    stop();
  });

  it("stops following once it is unhooked", () => {
    const a = scroller();
    const b = scroller();
    syncMergeScroll(a, b)();

    a.scrollTop = 90;
    expect(b.scrollTop).toBe(0);
  });
});
