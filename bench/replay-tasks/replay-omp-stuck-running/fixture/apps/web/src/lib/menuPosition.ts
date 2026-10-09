import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/** Breathing room kept between a floating menu and the viewport edge. */
export const MENU_VIEWPORT_MARGIN = 8;

export type MenuAnchor = { x: number; y: number };

export type MenuPlacement = {
  left: number;
  top: number;
  /** Cap for the menu's own scroller; never larger than the viewport allows. */
  maxHeight: number;
  maxWidth: number;
};

/**
 * Clamp a pointer-anchored floating menu into the viewport. A menu taller than
 * the viewport keeps its top edge on screen and scrolls its own content rather
 * than running off the bottom edge — on phones the git panel fills the screen,
 * so a long file menu opened near the bottom of the tree would otherwise lose
 * its last items with no way to reach them.
 */
export function clampMenuPlacement(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = MENU_VIEWPORT_MARGIN,
): MenuPlacement {
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  // `Math.max(min, max)` keeps the range valid when the viewport is smaller
  // than twice the margin, so the menu still gets clamped to the margin.
  return {
    left: Math.min(Math.max(anchor.x, margin), Math.max(margin, viewport.width - width - margin)),
    top: Math.min(Math.max(anchor.y, margin), Math.max(margin, viewport.height - height - margin)),
    maxHeight,
    maxWidth,
  };
}

/**
 * Style for a `position: fixed` menu anchored at a pointer position. The menu
 * is measured after every render (its item count changes with the selection)
 * and re-placed before paint, so nothing flashes at the unclamped spot.
 * Returns null while `anchor` is null (menu closed).
 */
export function useFixedMenuPlacement(
  anchor: MenuAnchor | null,
  menuRef: RefObject<HTMLElement | null>,
): CSSProperties | null {
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [, bumpMeasurement] = useReducer((n: number) => n + 1, 0);

  useLayoutEffect(() => {
    if (!anchor) {
      setPlacement(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    // `scrollHeight` keeps reporting the natural height after `maxHeight`
    // already clipped the box, so growing menus stay measured correctly.
    const next = clampMenuPlacement(
      anchor,
      { width: el.offsetWidth, height: Math.max(el.offsetHeight, el.scrollHeight) },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.maxHeight === next.maxHeight &&
      prev.maxWidth === next.maxWidth
        ? prev
        : next,
    );
  });

  useEffect(() => {
    if (!anchor) return;
    const onResize = () => bumpMeasurement();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [anchor]);

  if (!anchor) return null;
  return {
    left: placement?.left ?? anchor.x,
    top: placement?.top ?? anchor.y,
    maxHeight: placement?.maxHeight,
    maxWidth: placement?.maxWidth,
    // Long menus scroll instead of spilling off the viewport.
    overflowY: "auto",
  };
}
