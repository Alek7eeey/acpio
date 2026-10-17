import { describe, expect, it } from "vitest";
import {
  bumpPatch,
  compareVersions,
  formatReleaseDay,
  latestVersion,
  nextVersion,
  parseReleaseVersion,
  parseVersionsMarkdown,
  renderVersionsMarkdown,
} from "./versionHistory.mjs";

describe("parseReleaseVersion", () => {
  it("accepts a release tag with or without the leading v", () => {
    expect(parseReleaseVersion("v0.1.38")).toBe("0.1.38");
    expect(parseReleaseVersion("0.1.38")).toBe("0.1.38");
  });

  it("refuses anything that is not a release", () => {
    expect(parseReleaseVersion("v0.1.39-rc.1")).toBeNull();
    expect(parseReleaseVersion("v0.1.39+ci.7")).toBeNull();
    expect(parseReleaseVersion("release-0.1.39")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
    expect(parseReleaseVersion(undefined)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares part by part, not as strings", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.38", "0.1.38")).toBe(0);
  });
});

describe("nextVersion", () => {
  it("keeps the base version while nothing is released", () => {
    expect(nextVersion({ baseVersion: "0.1.0", releases: [] })).toBe("0.1.0");
  });

  it("bumps one patch above the highest release, whatever the commit count", () => {
    expect(nextVersion({ baseVersion: "0.1.0", releases: ["0.1.38"] })).toBe("0.1.39");
    expect(nextVersion({ baseVersion: "0.1.0", releases: ["0.1.9", "0.1.38", "0.1.30"] })).toBe("0.1.39");
  });

  it("moves major and minor only when a tag says so", () => {
    expect(nextVersion({ baseVersion: "0.1.0", releases: ["0.2.7"] })).toBe("0.2.8");
    expect(nextVersion({ baseVersion: "0.1.0", releases: ["1.0.0"] })).toBe("1.0.1");
  });
});

describe("bumpPatch", () => {
  it("adds one to the patch", () => {
    expect(bumpPatch("0.1.38")).toBe("0.1.39");
  });
});

describe("latestVersion", () => {
  it("is null without releases and the highest one otherwise", () => {
    expect(latestVersion([])).toBeNull();
    expect(latestVersion(["0.1.9", "0.1.10", "0.1.2"])).toBe("0.1.10");
  });
});

describe("formatReleaseDay", () => {
  it("formats git's author day as DD.MM.YY", () => {
    expect(formatReleaseDay("2026-08-26")).toBe("26.08.26");
    expect(formatReleaseDay("2026-10-17")).toBe("17.10.26");
  });
});

describe("version history markdown", () => {
  it("parses and renders release rows", () => {
    const raw = renderVersionsMarkdown([
      { version: "0.1.39", released: "18.10.26" },
      { version: "0.1.38", released: "17.10.26" },
    ]);
    expect(parseVersionsMarkdown(raw)).toEqual([
      { version: "0.1.39", released: "18.10.26" },
      { version: "0.1.38", released: "17.10.26" },
    ]);
  });

  it("renders just the header while nothing is released", () => {
    expect(parseVersionsMarkdown(renderVersionsMarkdown([]))).toEqual([]);
  });
});
