import { MIN_REMAINING_CHAT_PX } from "./panelLayout";

/**
 * Geometry of the git review surface. The panel is always `[stage | navigator]`:
 * the navigator is a fixed-ish column that stages files and writes the commit,
 * the stage is whatever is left and shows the diff.
 *
 * The dock is a preview, not the reading surface — the reader who wants room
 * opens the diff full-screen instead — so it opens at a modest share of the page
 * and the splitter owns it from there.
 */
export const GIT_NAVIGATOR_WIDTH = 380;
export const GIT_NAVIGATOR_MIN_WIDTH = 270;
export const GIT_STAGE_MIN_WIDTH = 350;

/**
 * Narrowest panel that still fits both columns. Below it the navigator stops
 * being a column and becomes a sheet over the stage, so the diff keeps the full
 * width instead of a sliver of it.
 */
export const GIT_SPLIT_MIN_WIDTH = GIT_NAVIGATOR_MIN_WIDTH + GIT_STAGE_MIN_WIDTH;

/** Share of the page the dock opens at. */
export const GIT_PANEL_WIDTH_DEFAULT_RATIO = 0.44;
/**
 * Floor of the default: the dock opens wide enough for both columns, so a
 * first-time reader never lands in the in-between zone by accident. The fold
 * the splitter may drag the dock between is wider than that.
 */
export const GIT_PANEL_WIDTH_DEFAULT_MIN = GIT_SPLIT_MIN_WIDTH;
export const GIT_PANEL_WIDTH_DEFAULT_MAX = 900;
export const GIT_PANEL_WIDTH_MIN = 520;
export const GIT_PANEL_WIDTH_MAX = 1400;

/** Dock width the panel opens at on a page this wide. */
export function gitDefaultPanelWidth(pageWidth: number): number {
  const share = pageWidth * GIT_PANEL_WIDTH_DEFAULT_RATIO;
  return Math.round(
    Math.min(GIT_PANEL_WIDTH_DEFAULT_MAX, Math.max(GIT_PANEL_WIDTH_DEFAULT_MIN, share)),
  );
}

/**
 * Fit a desired dock width to what the page affords. The ceiling is a real
 * number rather than "whatever is left": the panel is dragged, so it may not
 * grow until the chat has nowhere left to sit — the reader can always review
 * the diff full-screen instead.
 */
export function clampGitPanelWidth(width: number, pageWidth: number): number {
  const cap = Math.max(
    GIT_PANEL_WIDTH_MIN,
    Math.min(GIT_PANEL_WIDTH_MAX, pageWidth - MIN_REMAINING_CHAT_PX),
  );
  if (!Number.isFinite(width)) return Math.min(gitDefaultPanelWidth(pageWidth), cap);
  return Math.min(cap, Math.max(GIT_PANEL_WIDTH_MIN, Math.round(width)));
}

/**
 * Navigator column width. Yields to the stage when the panel is narrow, so the
 * diff never falls below `GIT_STAGE_MIN_WIDTH` while the panel is at least
 * `GIT_SPLIT_MIN_WIDTH` wide.
 */
export function gitNavigatorWidthFor(panelWidth: number): number {
  const roomy = Math.max(GIT_NAVIGATOR_MIN_WIDTH, panelWidth - GIT_STAGE_MIN_WIDTH);
  return Math.min(GIT_NAVIGATOR_WIDTH, roomy);
}
