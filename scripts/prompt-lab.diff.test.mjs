import { describe, expect, it } from "vitest";
import { diffLines, diffStats } from "./prompt-lab.diff.mjs";

const render = (rows) => rows.map((r) => (r.op === "=" ? " " : r.op) + r.text);

describe("diffLines", () => {
  it("shows an unchanged prompt as untouched lines", () => {
    expect(render(diffLines("a\nb\nc", "a\nb\nc"))).toEqual([" a", " b", " c"]);
    expect(diffStats(diffLines("a", "a"))).toEqual({ added: 0, removed: 0 });
  });

  it("marks a replaced line as one removal and one addition", () => {
    expect(render(diffLines("a\nb", "a\nc"))).toEqual([" a", "-b", "+c"]);
    expect(diffStats(diffLines("a\nb", "a\nc"))).toEqual({ added: 1, removed: 1 });
  });

  it("keeps an inserted line in place instead of rewriting the tail", () => {
    // The property that matters for a prompt: a block added in the middle leaves
    // every line after it untouched, so the reader sees one insertion.
    expect(render(diffLines("head\ntail", "head\nnew\ntail"))).toEqual([" head", "+new", " tail"]);
    expect(diffStats(diffLines("head\ntail", "head\nnew\ntail"))).toEqual({ added: 1, removed: 0 });
  });

  it("diffs an empty prompt into a whole addition and back", () => {
    expect(diffStats(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines("a\nb", ""))).toEqual({ added: 0, removed: 2 });
  });
});
