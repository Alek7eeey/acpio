import { describe, expect, it } from "vitest";
import { buildDiffGaps, parseUnifiedDiff } from "./gitDiffParse";

describe("parseUnifiedDiff", () => {
  it("detects hidden lines before the first hunk", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -10,3 +10,4 @@",
      " context",
      "-old",
      "+new",
      "+added",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const gaps = buildDiffGaps(files[0]!, 0);
    const before = gaps.find((gap) => gap.id.endsWith("-before-0"));
    expect(before?.hiddenCount).toBe(8);
  });

  it("detects hidden lines between hunks", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+x",
      "@@ -20,3 +20,3 @@",
      " z",
      "-y",
      "+w",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    const gaps = buildDiffGaps(files[0]!, 0);
    const between = gaps.find((gap) => gap.id.includes("-between-"));
    expect(between?.hiddenCount).toBe(16);
    expect(between?.gapStart).toBe(3);
    expect(between?.gapEnd).toBe(18);
  });
});
