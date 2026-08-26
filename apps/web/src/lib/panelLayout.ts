import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "./store";

/** Plan / console / git panels overlay the chat below this viewport width. */
export const COMPACT_PANEL_LAYOUT_MAX = 1180;

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

export function isOverlayPanelLayout(width = window.innerWidth, sidebarOpen = useAppStore.getState().sidebarOpen) {
  if (width <= COMPACT_PANEL_LAYOUT_MAX) return true;
  return width >= wideOverlayPanelMin(sidebarOpen);
}

/** Side-docked panels with a draggable splitter (viewport wider than compact overlay). */
export function isSidePanelResizeAllowed(width = window.innerWidth) {
  return width > COMPACT_PANEL_LAYOUT_MAX;
}

export function isDockedPanelLayout(width = window.innerWidth, sidebarOpen = useAppStore.getState().sidebarOpen) {
  return isSidePanelResizeAllowed(width);
}

export function isCompactPanelLayout(width = window.innerWidth, sidebarOpen = useAppStore.getState().sidebarOpen) {
  return isOverlayPanelLayout(width, sidebarOpen);
}

export function isChatSplitAllowed(width = window.innerWidth) {
  return isSidePanelResizeAllowed(width);
}

export function useOverlayPanelLayout() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0));

  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return useMemo(() => isOverlayPanelLayout(width, sidebarOpen), [sidebarOpen, width]);
}

export function useChatSplitAllowed() {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0));

  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return useMemo(() => isChatSplitAllowed(width), [width]);
}

/** True only for narrow overlay (≤1180px), not wide desktop overlay. */
export function isNarrowPanelLayout(width = window.innerWidth) {
  return width <= COMPACT_PANEL_LAYOUT_MAX;
}

export function useNarrowPanelLayout() {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0));

  useEffect(() => {
    const sync = () => setWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return useMemo(() => isNarrowPanelLayout(width), [width]);
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
