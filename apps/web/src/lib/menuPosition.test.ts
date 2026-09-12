import { describe, it, expect } from "vitest";
import { MENU_VIEWPORT_MARGIN, clampMenuPlacement } from "./menuPosition";

const VIEWPORT = { width: 390, height: 844 };
/** The git file menu at its longest (11 items). */
const MENU = { width: 220, height: 408 };
const EDGE = 2 * MENU_VIEWPORT_MARGIN;

describe("clampMenuPlacement", () => {
  it("leaves a menu that already fits at the pointer", () => {
    expect(clampMenuPlacement({ x: 40, y: 100 }, MENU, VIEWPORT)).toEqual({
      left: 40,
      top: 100,
      maxHeight: VIEWPORT.height - EDGE,
      maxWidth: VIEWPORT.width - EDGE,
    });
  });

  it("pulls a menu opened near the bottom-right corner back on screen", () => {
    const { left, top } = clampMenuPlacement({ x: 384, y: 812 }, MENU, VIEWPORT);

    expect(left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - MENU_VIEWPORT_MARGIN);
    expect(top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - MENU_VIEWPORT_MARGIN);
  });

  it("never pushes a menu above or left of the viewport margin", () => {
    expect(clampMenuPlacement({ x: -30, y: -50 }, MENU, VIEWPORT)).toMatchObject({
      left: MENU_VIEWPORT_MARGIN,
      top: MENU_VIEWPORT_MARGIN,
    });
  });

  it("caps the height and keeps the top edge visible when the menu is taller than the viewport", () => {
    const { top, maxHeight } = clampMenuPlacement({ x: 20, y: 500 }, { width: 220, height: 1200 }, VIEWPORT);

    expect(maxHeight).toBe(VIEWPORT.height - EDGE);
    expect(top).toBe(MENU_VIEWPORT_MARGIN);
  });

  it("keeps the top-left corner on screen when the viewport is narrower than the menu", () => {
    const { left, top, maxWidth } = clampMenuPlacement(
      { x: 5, y: 5 },
      { width: 320, height: 200 },
      { width: 240, height: 130 },
    );

    expect(left).toBe(MENU_VIEWPORT_MARGIN);
    expect(top).toBe(MENU_VIEWPORT_MARGIN);
    expect(maxWidth).toBe(240 - EDGE);
  });
});
