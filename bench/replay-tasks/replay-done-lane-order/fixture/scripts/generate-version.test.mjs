import { describe, expect, it } from "vitest";
import {
  computeAppVersion,
  formatReleaseDate,
  parseVersionsMarkdown,
  releaseEntriesFromCommitDates,
  renderVersionsMarkdown,
  uniqueCommitDays,
  upsertReleaseEntry,
} from "./versionHistory.mjs";

describe("uniqueCommitDays", () => {
  it("keeps unique days on or after the epoch", () => {
    expect(
      uniqueCommitDays(["2026-08-27", "2026-08-27", "2026-08-26", "2026-08-25"], "2026-08-26"),
    ).toEqual(["2026-08-26", "2026-08-27"]);
  });
});

describe("computeAppVersion", () => {
  it("keeps base version on the first git day", () => {
    const result = computeAppVersion({
      baseVersion: "0.1.0",
      epochDate: "2026-08-26",
      commitDates: ["2026-08-26", "2026-08-26"],
    });
    expect(result.version).toBe("0.1.0");
    expect(result.uniqueDays).toBe(1);
  });

  it("bumps patch once per later git day, not per commit", () => {
    const result = computeAppVersion({
      baseVersion: "0.1.0",
      epochDate: "2026-08-26",
      commitDates: ["2026-08-27", "2026-08-27", "2026-08-26"],
    });
    expect(result.version).toBe("0.1.1");
    expect(result.uniqueDays).toBe(2);
  });

  it("does not bump for a local calendar day with no git commits", () => {
    const result = computeAppVersion({
      baseVersion: "0.1.0",
      epochDate: "2026-08-26",
      commitDates: ["2026-08-26"],
    });
    expect(result.version).toBe("0.1.0");
  });
});

describe("releaseEntriesFromCommitDates", () => {
  it("lists newest git day first", () => {
    expect(
      releaseEntriesFromCommitDates({
        baseVersion: "0.1.0",
        epochDate: "2026-08-26",
        commitDates: ["2026-08-27", "2026-08-26", "2026-08-26"],
      }),
    ).toEqual([
      { version: "0.1.1", released: "27.08.26" },
      { version: "0.1.0", released: "26.08.26" },
    ]);
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
      { version: "0.1.1", released: "27.08.26" },
      { version: "0.1.0", released: "26.08.26" },
    ]);
    expect(parseVersionsMarkdown(raw)).toEqual([
      { version: "0.1.1", released: "27.08.26" },
      { version: "0.1.0", released: "26.08.26" },
    ]);
  });

  it("does not duplicate an existing version", () => {
    const entries = upsertReleaseEntry([{ version: "0.1.1", released: "27.08.26" }], "0.1.1", "27.08.26");
    expect(entries).toEqual([{ version: "0.1.1", released: "27.08.26" }]);
  });
});
