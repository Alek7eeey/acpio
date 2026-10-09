import { describe, expect, it } from "vitest";
import { buildSideBySideRows, buildUnifiedDiffRows, diffInlineSegments } from "./gitDiffInline";
import { parseUnifiedDiff } from "./gitDiffParse";

describe("diffInlineSegments", () => {
  it("highlights only changed words", () => {
    const { old, new: newer } = diffInlineSegments("hello world", "hello there");
    expect(old).toEqual([
      { type: "equal", text: "hello " },
      { type: "delete", text: "world" },
    ]);
    expect(newer).toEqual([
      { type: "equal", text: "hello " },
      { type: "insert", text: "there" },
    ]);
  });

  it("marks fully inserted text", () => {
    const { new: newer } = diffInlineSegments("", "added line");
    expect(newer).toEqual([{ type: "insert", text: "added line" }]);
  });
});

describe("buildSideBySideRows", () => {
  it("pairs deleted and added lines side by side", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " ctx",
      "-old",
      "+new",
    ].join("\n");
    const hunk = parseUnifiedDiff(diff)[0]!.hunks[0]!;
    expect(buildSideBySideRows(hunk)).toEqual([
      {
        oldLineNo: 1,
        newLineNo: 1,
        oldText: "ctx",
        newText: "ctx",
        kind: "context",
      },
      {
        oldLineNo: 2,
        newLineNo: 2,
        oldText: "old",
        newText: "new",
        kind: "change",
      },
    ]);
  });
});

describe("buildUnifiedDiffRows", () => {
  it("creates paired change rows with inline segments", () => {
    const diff = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,2 +1,2 @@",
      "-foo bar",
      "+foo baz",
    ].join("\n");
    const lines = parseUnifiedDiff(diff)[0]!.hunks[0]!.lines;
    const rows = buildUnifiedDiffRows(lines);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "change",
      oldSegments: [
        { type: "equal", text: "foo " },
        { type: "delete", text: "bar" },
      ],
      newSegments: [
        { type: "equal", text: "foo " },
        { type: "insert", text: "baz" },
      ],
    });
  });
});
