import { describe, expect, it } from "vitest";
import { parseLeftRightCount } from "./git.js";

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
