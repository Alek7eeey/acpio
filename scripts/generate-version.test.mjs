import { describe, expect, it } from "vitest";
import {
  computeAppVersion,
  countUniqueCommitDays,
  formatReleaseDate,
  parseVersionsMarkdown,
  renderVersionsMarkdown,
  upsertReleaseEntry,
} from "./versionHistory.mjs";

describe("computeAppVersion", () => {
  it("bumps patch once per calendar day with commits, not per commit", () => {
    const result = computeAppVersion({
      baseVersion: "0.1.0",
      epochDate: "2026-08-26",
      commitDates: [
        "2026-08-26",
        "2026-08-26",
        "2026-08-26",
        "2026-08-25",
      ],
    });
    expect(result.version).toBe("0.1.1");
    expect(result.daysWithCommits).toBe(1);
  });

  it("counts each active day since the epoch", () => {
    const result = computeAppVersion({
      baseVersion: "0.1.0",
      epochDate: "2026-08-26",
      commitDates: ["2026-08-27", "2026-08-26", "2026-08-26"],
    });
    expect(result.version).toBe("0.1.2");
    expect(result.daysWithCommits).toBe(2);
  });

  it("ignores days before the epoch", () => {
    expect(
      countUniqueCommitDays(["2026-08-25", "2026-08-26"].filter((d) => d >= "2026-08-26")),
    ).toBe(1);
  });
});

describe("formatReleaseDate", () => {
  it("formats dates as DD.MM.YY", () => {
    expect(formatReleaseDate(new Date(2026, 7, 26, 15, 30))).toBe("26.08.26");
  });
});

describe("version history markdown", () => {
  it("parses and renders release rows", () => {
    const raw = renderVersionsMarkdown([
      { version: "0.1.2", released: "26.08.26" },
      { version: "0.1.1", released: "25.08.26" },
    ]);
    expect(parseVersionsMarkdown(raw)).toEqual([
      { version: "0.1.2", released: "26.08.26" },
      { version: "0.1.1", released: "25.08.26" },
    ]);
  });

  it("does not duplicate an existing version", () => {
    const entries = upsertReleaseEntry([{ version: "0.1.2", released: "26.08.26" }], "0.1.2", "26.08.26");
    expect(entries).toEqual([{ version: "0.1.2", released: "26.08.26" }]);
  });

  it("prepends new versions", () => {
    const entries = upsertReleaseEntry([{ version: "0.1.1", released: "25.08.26" }], "0.1.2", "26.08.26");
    expect(entries).toEqual([
      { version: "0.1.2", released: "26.08.26" },
      { version: "0.1.1", released: "25.08.26" },
    ]);
  });
});
