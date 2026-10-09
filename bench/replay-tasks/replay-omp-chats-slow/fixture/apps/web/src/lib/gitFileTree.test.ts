import { describe, it, expect } from "vitest";
import { buildGitFileTreeRows } from "./gitFileTree";

const FILES = [
  { path: "web/src/app.ts" },
  { path: "web/src/lib/util.ts" },
  { path: "readme.md" },
  { path: "web/host/main.ts" },
];

describe("buildGitFileTreeRows", () => {
  it("nests files under their folders, dirs before files, sorted by name", () => {
    const rows = buildGitFileTreeRows(FILES);

    expect(rows.map((row) => `${row.kind === "dir" ? "d" : "f"}:${row.path}@${row.depth}`)).toEqual([
      "d:web@0",
      "d:web/host@1",
      "f:web/host/main.ts@2",
      "d:web/src@1",
      "d:web/src/lib@2",
      "f:web/src/lib/util.ts@3",
      "f:web/src/app.ts@2",
      "f:readme.md@0",
    ]);
  });

  it("keeps the caller's file order as the navigation index", () => {
    const rows = buildGitFileTreeRows(FILES);
    const files = rows.filter((row) => row.kind === "file");
    // Order inside one folder follows the input order, and every index is unique.
    expect(files.map((row) => row.index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(files.find((row) => row.path === "readme.md")?.index).toBe(2);
  });

  it("folds a folder subtree when it is collapsed", () => {
    const rows = buildGitFileTreeRows(FILES, new Set(["web/src"]));
    expect(rows.some((row) => row.path.startsWith("web/src/"))).toBe(false);
    expect(rows.some((row) => row.path === "web/host/main.ts")).toBe(true);
  });

  it("treats stale windows separators as folder boundaries", () => {
    const rows = buildGitFileTreeRows([{ path: "web\\src\\app.ts" }]);
    expect(rows.map((row) => row.path)).toEqual(["web", "web/src", "web/src/app.ts"]);
  });
});
