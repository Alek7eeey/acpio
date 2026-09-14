import { useLayoutEffect, useEffect, useMemo, useState, type RefObject } from "react";

/** Plan / console / git panels overlay the chat below this viewport width. */
export const COMPACT_PANEL_LAYOUT_MAX = 1180;

/**
 * Phone layout: below this width the shell becomes the one-hand bottom sheet
 * (AppShell's `max-width: 899px` block) — a header on top, a chat dock under it.
 * Right-hand panels take the whole viewport there instead of docking into the
 * slice the shell leaves them.
 */
export const PHONE_PANEL_LAYOUT_MAX = 899;

/** Full-width panels on wide viewports when the session tree is collapsed. */
export const WIDE_OVERLAY_PANEL_MIN_TREE_COLLAPSED = 1200;

/** Full-width panels on wide viewports when the session tree is expanded. */
export const WIDE_OVERLAY_PANEL_MIN_TREE_OPEN = 1600;

/** @deprecated Use wideOverlayPanelMin(sidebarOpen) instead. */
export const WIDE_OVERLAY_PANEL_MIN = WIDE_OVERLAY_PANEL_MIN_TREE_OPEN;

export const COMPACT_PANEL_LAYOUT_MQ = `(max-width: ${COMPACT_PANEL_LAYOUT_MAX}px)`;

export function wideOverlayPanelMin(sidebarOpen: boolean) {
  return sidebarOpen ? WIDE_OVERLAY_PANEL_MIN_TREE_OPEN : WIDE_OVERLAY_PANEL_MIN_TREE_COLLAPSED;
}

export function isOverlayPanelLayout(width = typeof window !== "undefined" ? window.innerWidth : 0) {
  return width <= COMPACT_PANEL_LAYOUT_MAX;
}

/** Hide chat and let the right tab fill when this much (or less) would remain. */
export const MIN_REMAINING_CHAT_PX = 360;
/** Stay filled until a bit more space is back, so the layout does not flicker. */
export const MIN_REMAINING_CHAT_EXIT_PX = 420;

function visiblePageAside(page: HTMLElement): HTMLElement | null {
  for (const el of page.querySelectorAll("aside")) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.hidden) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    return el;
  }
  return null;
}

function dockedPanelWidthPx(page: HTMLElement): number {
  const el = visiblePageAside(page);
  const cap = Math.min(window.innerWidth * 0.72, page.clientWidth);
  if (!el) return Math.min(520, cap);
  const cs = getComputedStyle(el);
  for (const name of ["--git-panel-width", "--console-panel-width", "--plan-panel-width"]) {
    const n = Number.parseFloat(cs.getPropertyValue(name));
    if (Number.isFinite(n) && n > 40) return Math.min(n, cap);
  }
  return Math.min(520, cap);
}

/** Full-width right tab only when the leftover chat column would be a sliver (or the viewport is already compact). */
export function useFillPanelWhenChatTight(pageRef: RefObject<HTMLElement | null>, panelOpen: boolean) {
  const [fill, setFill] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= COMPACT_PANEL_LAYOUT_MAX,
  );

  useLayoutEffect(() => {
    if (!panelOpen) {
      setFill(typeof window !== "undefined" && window.innerWidth <= COMPACT_PANEL_LAYOUT_MAX);
      return;
    }
    const page = pageRef.current;
    if (!page) return;

    const measure = () => {
      if (window.innerWidth <= COMPACT_PANEL_LAYOUT_MAX) {
        setFill(true);
        return;
      }
      const remaining = page.clientWidth - dockedPanelWidthPx(page);
      setFill((prev) => {
        if (remaining < MIN_REMAINING_CHAT_PX) return true;
        if (remaining >= MIN_REMAINING_CHAT_EXIT_PX) return false;
        return prev;
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(page);
    const watchAside = () => {
      const aside = visiblePageAside(page);
      if (aside) ro.observe(aside);
    };
    watchAside();
    const mo = new MutationObserver(() => {
      watchAside();
      measure();
    });
    mo.observe(page, { childList: true });
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pageRef, panelOpen]);

  return panelOpen && fill;
}

/** Side-docked panels with a draggable splitter (viewport wider than compact overlay). */
export function isSidePanelResizeAllowed(width = window.innerWidth) {
  return width > COMPACT_PANEL_LAYOUT_MAX;
}

export function isDockedPanelLayout(width = typeof window !== "undefined" ? window.innerWidth : 0) {
  return isSidePanelResizeAllowed(width);
}

export function isCompactPanelLayout(width = typeof window !== "undefined" ? window.innerWidth : 0) {
  return isOverlayPanelLayout(width);
}

export function isChatSplitAllowed(width = window.innerWidth) {
  return isSidePanelResizeAllowed(width);
}

/** Current viewport width, re-read on every resize. */
function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0));

  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return width;
}

export function useOverlayPanelLayout() {
  const width = useViewportWidth();
  return useMemo(() => isOverlayPanelLayout(width), [width]);
}

export function useChatSplitAllowed() {
  const width = useViewportWidth();
  return useMemo(() => isChatSplitAllowed(width), [width]);
}

/** True only for narrow overlay (≤1180px), not wide desktop overlay. */
export function isNarrowPanelLayout(width = window.innerWidth) {
  return width <= COMPACT_PANEL_LAYOUT_MAX;
}

export function useNarrowPanelLayout() {
  const width = useViewportWidth();
  return useMemo(() => isNarrowPanelLayout(width), [width]);
}

/** True for the one-hand phone layout (see the media query in AppShell). */
export function isPhonePanelLayout(width = window.innerWidth) {
  return width <= PHONE_PANEL_LAYOUT_MAX;
}

export function usePhonePanelLayout() {
  const width = useViewportWidth();
  return useMemo(() => isPhonePanelLayout(width), [width]);
}

/** Alias for overlay layout (compact + wide fullscreen). */
export function useCompactPanelLayout() {
  return useOverlayPanelLayout();
}

/** @deprecated Split availability is sidebar- and width-dependent; use useChatSplitAllowed(). */
export const DOCKED_PANEL_LAYOUT_MIN = COMPACT_PANEL_LAYOUT_MAX + 1;
/** @deprecated */
export const DOCKED_PANEL_LAYOUT_MAX = WIDE_OVERLAY_PANEL_MIN_TREE_OPEN - 1;
/** @deprecated */
export const CHAT_SPLIT_MIN_PX = DOCKED_PANEL_LAYOUT_MIN;
/** @deprecated */
export const CHAT_SPLIT_MAX_PX = DOCKED_PANEL_LAYOUT_MAX;
/** @deprecated */
export const CHAT_SPLIT_MQ = `(min-width: ${DOCKED_PANEL_LAYOUT_MIN}px)`;
