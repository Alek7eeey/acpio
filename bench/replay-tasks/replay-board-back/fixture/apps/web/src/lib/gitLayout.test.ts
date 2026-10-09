import { describe, expect, it } from "vitest";
import { MIN_REMAINING_CHAT_PX } from "./panelLayout";
import {
  GIT_NAVIGATOR_MIN_WIDTH,
  GIT_NAVIGATOR_WIDTH,
  GIT_PANEL_WIDTH_DEFAULT_MAX,
  GIT_PANEL_WIDTH_MIN,
  GIT_PANEL_WIDTH_MAX,
  GIT_SPLIT_MIN_WIDTH,
  GIT_STAGE_MIN_WIDTH,
  clampGitPanelWidth,
  gitDefaultPanelWidth,
  gitNavigatorWidthFor,
} from "./gitLayout";

/** Page widths actually reachable on desktop: viewport 1181..2200 minus the sidebar. */
const PAGE_WIDTHS = [821, 880, 1080, 1120, 1240, 1260, 1560, 1840];

describe("gitDefaultPanelWidth", () => {
  it("opens a preview dock, not half the monitor", () => {
    for (const page of [1240, 1440, 1560, 1840, 2200]) {
      expect(gitDefaultPanelWidth(page)).toBeLessThanOrEqual(GIT_PANEL_WIDTH_DEFAULT_MAX);
      expect(gitDefaultPanelWidth(page)).toBeLessThan(page * 0.6);
    }
  });

  it("still opens wide enough for both columns", () => {
    for (const page of PAGE_WIDTHS) {
      expect(gitDefaultPanelWidth(page)).toBeGreaterThanOrEqual(GIT_SPLIT_MIN_WIDTH);
    }
  });
});

describe("clampGitPanelWidth", () => {
  it("opens at the default dock on every page that can afford it", () => {
    for (const page of PAGE_WIDTHS) {
      const want = gitDefaultPanelWidth(page);
      if (page - MIN_REMAINING_CHAT_PX < want) continue;
      expect(clampGitPanelWidth(want, page)).toBe(want);
    }
  });

  it("keeps the chat its minimum rather than taking the whole page", () => {
    for (const page of PAGE_WIDTHS) {
      const panel = clampGitPanelWidth(gitDefaultPanelWidth(page), page);
      expect(panel).toBeLessThanOrEqual(Math.max(GIT_PANEL_WIDTH_MIN, page - MIN_REMAINING_CHAT_PX));
      expect(panel).toBeLessThanOrEqual(page);
    }
  });

  it("honours a dragged width while it fits and the page ceiling after that", () => {
    expect(clampGitPanelWidth(700, 1560)).toBe(700);
    expect(clampGitPanelWidth(1300, 1560)).toBe(1560 - MIN_REMAINING_CHAT_PX);
    expect(clampGitPanelWidth(9999, 4000)).toBe(GIT_PANEL_WIDTH_MAX);
  });

  it("never folds the dock below its minimum", () => {
    for (const page of PAGE_WIDTHS) {
      expect(clampGitPanelWidth(120, page)).toBe(GIT_PANEL_WIDTH_MIN);
    }
  });

  it("falls back to the default for a corrupt stored width", () => {
    expect(clampGitPanelWidth(Number.NaN, 1560)).toBe(gitDefaultPanelWidth(1560));
  });
});

describe("gitNavigatorWidthFor", () => {
  it("gives the stage its minimum whenever the navigator is a column", () => {
    for (const page of PAGE_WIDTHS) {
      const panel = clampGitPanelWidth(gitDefaultPanelWidth(page), page);
      // Narrower than the split: the navigator becomes a sheet over the stage.
      if (panel < GIT_SPLIT_MIN_WIDTH) continue;
      expect(panel - gitNavigatorWidthFor(panel)).toBeGreaterThanOrEqual(GIT_STAGE_MIN_WIDTH);
    }
  });

  it("gives the stage back its minimum by shrinking the navigator first", () => {
    // The stage's minimum comes first: growth goes to the navigator only until
    // it is back at its own width, and past that the stage keeps everything.
    expect(gitNavigatorWidthFor(GIT_SPLIT_MIN_WIDTH)).toBe(GIT_NAVIGATOR_MIN_WIDTH);
    expect(gitNavigatorWidthFor(GIT_SPLIT_MIN_WIDTH + 50)).toBe(GIT_NAVIGATOR_MIN_WIDTH + 50);
    expect(gitNavigatorWidthFor(GIT_NAVIGATOR_WIDTH + GIT_STAGE_MIN_WIDTH)).toBe(GIT_NAVIGATOR_WIDTH);
    expect(gitNavigatorWidthFor(GIT_NAVIGATOR_WIDTH + GIT_STAGE_MIN_WIDTH + 400)).toBe(
      GIT_NAVIGATOR_WIDTH,
    );
  });
});
