// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

const { readWorkspace, writeWorkspace } = await import("./EditorPage");

describe("workspace: what a reload reads back", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the caret of every file", () => {
    writeWorkspace(
      "/repo",
      [{ kind: "file", path: "web/a.ts" }],
      "file:web/a.ts",
      { "web/a.ts": { line: 114, col: 7 } },
    );
    expect(readWorkspace("/repo")?.carets).toEqual({ "web/a.ts": { line: 114, col: 7 } });
  });

  it("drops a caret that is not a position", () => {
    localStorage.setItem(
      "acpio.editor.workspace.v1:/repo",
      JSON.stringify({
        tabs: [{ kind: "file", path: "web/a.ts" }],
        active: "file:web/a.ts",
        carets: { "web/a.ts": { line: "x", col: 2 }, "web/b.ts": { line: 5, col: 1 } },
      }),
    );
    expect(readWorkspace("/repo")?.carets).toEqual({ "web/b.ts": { line: 5, col: 1 } });
  });
});
