import { describe, it, expect } from "vitest";
import { isLargePastedText, pastedTextFileName, spliceComposerText } from "./pasteAsFile";

describe("isLargePastedText", () => {
  it("takes a long line and a tall block, and nothing in between", () => {
    expect(isLargePastedText("x".repeat(1500))).toBe(true);
    expect(isLargePastedText(Array.from({ length: 20 }, () => "line").join("\n"))).toBe(true);
    expect(isLargePastedText("x".repeat(1499))).toBe(false);
    expect(isLargePastedText(Array.from({ length: 19 }, () => "line").join("\n"))).toBe(false);
  });
});

describe("pastedTextFileName", () => {
  it("stamps the millisecond, so two pastes take two names", async () => {
    const first = pastedTextFileName();
    await new Promise((done) => setTimeout(done, 2));
    const second = pastedTextFileName();
    expect(first).toMatch(/^pasted-text-.+\.txt$/);
    expect(second).not.toBe(first);
  });
});

describe("spliceComposerText", () => {
  it("replaces the range the paste took, and appends when there is none", () => {
    expect(spliceComposerText("abXYef", "cd", { start: 2, end: 4 })).toBe("abcdef");
    expect(spliceComposerText("ab", "cd", null)).toBe("abcd");
    // A range the text no longer holds is clamped rather than thrown.
    expect(spliceComposerText("ab", "cd", { start: 9, end: 12 })).toBe("abcd");
  });
});
