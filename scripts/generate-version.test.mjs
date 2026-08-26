import { describe, expect, it } from "vitest";
import {
  formatReleaseDate,
  parseVersionsMarkdown,
  renderVersionsMarkdown,
  upsertReleaseEntry,
} from "./versionHistory.mjs";

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
