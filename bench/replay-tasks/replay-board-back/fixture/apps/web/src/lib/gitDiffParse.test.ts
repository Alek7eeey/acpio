import { describe, expect, it } from "vitest";
import {
  buildDiffGaps,
  diffFileStats,
  diffHeaderPath,
  parseUnifiedDiff,
  resolveDiffFilePath,
} from "./gitDiffParse";

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

describe("diffHeaderPath", () => {
  it("reads the new path from an unquoted header", () => {
    expect(diffHeaderPath("diff --git a/src/app.ts b/src/app.ts")).toBe("src/app.ts");
  });

  it("unquotes paths with spaces", () => {
    expect(diffHeaderPath('diff --git "a/my dir/x.ts" "b/my dir/x.ts"')).toBe("my dir/x.ts");
  });
});

describe("resolveDiffFilePath", () => {
  it("names binary files that have no ---/+++ lines", () => {
    const diff = [
      "diff --git a/piper/piper.exe b/piper/piper.exe",
      "new file mode 100644",
      "index 0000000..47d908d",
      "Binary files /dev/null and b/piper/piper.exe differ",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(resolveDiffFilePath(files[0]!)).toBe("piper/piper.exe");
  });

  it("prefers the new path of a regular file", () => {
    const diff = ["--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(resolveDiffFilePath(parseUnifiedDiff(diff)[0]!)).toBe("new.ts");
  });
});

describe("diffFileStats", () => {
  it("counts added and removed lines per file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
    ].join("\n");

    expect(diffFileStats(parseUnifiedDiff(diff)[0]!)).toEqual({ additions: 2, deletions: 1 });
  });
});
