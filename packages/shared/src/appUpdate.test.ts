import { describe, it, expect } from "vitest";
import { compareVersions, isNewerVersion, parseVersion } from "./appUpdate.js";

describe("parseVersion", () => {
  it("reads the three numbers and the prerelease", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseVersion("v0.1.42")).toEqual({ major: 0, minor: 1, patch: 42, pre: [] });
    expect(parseVersion("0.1.39-rc.1")).toEqual({ major: 0, minor: 1, patch: 39, pre: ["rc", "1"] });
  });

  it("refuses anything npm could not have published as a version", () => {
    for (const raw of ["", "latest", "1.2", "1.2.3.4", "1.2.x", "^0.1.0"]) {
      expect(parseVersion(raw)).toBeNull();
    }
  });
});

describe("compareVersions", () => {
  it("orders each number in turn", () => {
    expect(compareVersions("0.1.42", "0.1.41")).toBe(1);
    expect(compareVersions("0.1.41", "0.1.42")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("0.1.41", "0.1.41")).toBe(0);
  });

  it("ignores a leading v and build metadata", () => {
    expect(compareVersions("v0.1.42", "0.1.42")).toBe(0);
    expect(compareVersions("0.1.42+build.7", "0.1.42")).toBe(0);
  });

  it("puts a prerelease below the release it precedes", () => {
    expect(compareVersions("0.1.39-rc.1", "0.1.39")).toBe(-1);
    expect(compareVersions("0.1.39", "0.1.39-rc.1")).toBe(1);
    expect(compareVersions("0.1.39-rc.2", "0.1.39-rc.1")).toBe(1);
    // Numeric identifiers sort below alphanumeric ones, and 10 above 9.
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBe(1);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBe(1);
  });
});

describe("isNewerVersion", () => {
  it("announces only a version above this build's", () => {
    expect(isNewerVersion("0.1.42", "0.1.41")).toBe(true);
    expect(isNewerVersion("0.1.41", "0.1.41")).toBe(false);
    // Never walk backwards: an old registry answer is not an update.
    expect(isNewerVersion("0.1.40", "0.1.41")).toBe(false);
  });

  it("announces nothing when the registry answer is not a version", () => {
    expect(isNewerVersion("latest", "0.1.41")).toBe(false);
    expect(isNewerVersion("", "0.1.41")).toBe(false);
  });
});
