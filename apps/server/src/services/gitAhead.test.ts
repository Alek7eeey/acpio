import { describe, expect, it } from "vitest";
import { parseLeftRightCount, parseShortstat } from "./git.js";

describe("parseShortstat", () => {
  it.each([
    ["", { additions: 0, deletions: 0 }],
    [" 1 file changed, 5 insertions(+)", { additions: 5, deletions: 0 }],
    [" 2 files changed, 10 insertions(+), 3 deletions(-)", { additions: 10, deletions: 3 }],
    [" 1 file changed, 1 deletion(-)", { additions: 0, deletions: 1 }],
  ])("%j → %j", (raw, expected) => {
    expect(parseShortstat(raw)).toEqual(expected);
  });
});

describe("parseLeftRightCount", () => {
  it.each([
    ["0\t0", { behind: 0, ahead: 0 }],
    ["2\t5", { behind: 2, ahead: 5 }],
    ["3 1", { behind: 3, ahead: 1 }],
    ["", { behind: 0, ahead: 0 }],
    ["nope", { behind: 0, ahead: 0 }],
  ])("%j → %j", (raw, expected) => {
    expect(parseLeftRightCount(raw)).toEqual(expected);
  });
});
