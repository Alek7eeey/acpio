import { describe, expect, it } from "vitest";
import type { GitCommitDto } from "@acpio/shared";
import { assignCommitDepths } from "./gitCommitGraph";

function commit(hash: string, parents: string[]): GitCommitDto {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    subject: hash,
    author: "Tester",
    date: "2026-01-01T12:00:00+03:00",
    merge: parents.length > 1,
    refs: [],
  };
}

describe("assignCommitDepths", () => {
  it("draws a linear history on one line", () => {
    const rows = assignCommitDepths([commit("c", ["b"]), commit("b", ["a"]), commit("a", [])]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 0]);
  });

  it("gives every branch tip its own line and a merge a deeper side line", () => {
    const rows = assignCommitDepths([
      commit("main1", ["base"]),
      commit("merge", ["base", "side"]),
      commit("side", ["base"]),
      commit("base", []),
    ]);
    const depth = Object.fromEntries(rows.map((row) => [row.hash, row.depth]));
    expect(depth).toEqual({ main1: 0, merge: 0, side: 1, base: 0 });
  });

  it("keeps an older page on the line the graph already drew for it", () => {
    // First page: the merge is loaded, its side parent is not.
    const first = assignCommitDepths([commit("merge", ["base", "side"]), commit("base", [])]);
    expect(first.map((row) => row.depth)).toEqual([0, 0]);

    // Scrolling the side branch in must extend that line, not restart the graph.
    const grown = assignCommitDepths([
      commit("merge", ["base", "side"]),
      commit("base", []),
      commit("side", ["root"]),
      commit("root", []),
    ]);
    const depth = Object.fromEntries(grown.map((row) => [row.hash, row.depth]));
    // The side line carries on into its own parent instead of collapsing to 0.
    expect(depth).toEqual({ merge: 0, base: 0, side: 1, root: 1 });
  });

  it("leaves commits it does not know untouched", () => {
    const rows = assignCommitDepths([commit("c", ["missing"])]);
    expect(rows[0].depth).toBe(0);
  });
});
