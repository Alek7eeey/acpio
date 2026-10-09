import { describe, it, expect } from "vitest";
import type { SessionDto } from "@acpio/shared";
import { groupByFolder, sessionActivityAt, sessionRowMark } from "../lib/sessionTitle";

function session(id: string, cwd: string): SessionDto {
  return {
    id,
    title: id,
    provider: "omp",
    cwd,
    mode: "agent",
    status: "idle",
    themeId: null,
    sortOrder: 0,
    pinned: false,
    archived: false,
    mcpDisabledIds: [],
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    lastMessageAt: "2026-08-16T10:00:00.000Z",
    acpSessionId: null,
  };
}

describe("groupByFolder", () => {
  it("merges sessions whose cwd differs only in slash direction", () => {
    const groups = groupByFolder([
      session("a", "E:/testYura"),
      session("b", "E:\\testYura"),
      session("c", "E:\\testYura\\"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cwd).toBe("E:/testYura");
    expect(groups[0].sessions.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps distinct folders separate", () => {
    const groups = groupByFolder([session("a", "E:/one"), session("b", "E:\\two")]);
    expect(groups.map((g) => g.cwd).sort()).toEqual(["E:/one", "E:/two"]);
  });

  it("sorts top-level sessions by sortOrder and folder sessions by recency", () => {
    const s1 = { ...session("s1", ""), sortOrder: 5, lastMessageAt: "2026-08-16T12:00:00.000Z" };
    const s2 = { ...session("s2", ""), sortOrder: 2, lastMessageAt: "2026-08-16T10:00:00.000Z" };
    const s3 = { ...session("s3", "E:/folder"), sortOrder: 1, lastMessageAt: "2026-08-16T10:00:00.000Z" };
    const s4 = { ...session("s4", "E:/folder"), sortOrder: 9, lastMessageAt: "2026-08-16T15:00:00.000Z" };

    const groups = groupByFolder([s1, s2, s3, s4], ["E:/folder"]);

    // Folder group should be first, top-level group (empty cwd) should be last
    expect(groups).toHaveLength(2);
    expect(groups[0].cwd).toBe("E:/folder");
    expect(groups[1].cwd).toBe("");

    // Folder sessions should be sorted by recency (s4 is more recent than s3)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s4", "s3"]);

    // Top-level sessions should be sorted by sortOrder (s2 has sortOrder 2, s1 has sortOrder 5)
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("sorts folders by their order in knownFolders", () => {
    const s1 = session("s1", "E:/folderA");
    const s2 = session("s2", "E:/folderB");
    const s3 = session("s3", "E:/folderC");

    const groups = groupByFolder([s1, s2, s3], ["E:/folderC", "E:/folderA", "E:/folderB"]);
    expect(groups.map((g) => g.cwd)).toEqual(["E:/folderC", "E:/folderA", "E:/folderB"]);
  });
});

describe("sessionActivityAt", () => {
  it("uses lastMessageAt when present", () => {
    expect(sessionActivityAt(session("a", "E:/x"))).toBe("2026-08-16T10:00:00.000Z");
  });

  it("falls back to createdAt for empty chats", () => {
    const empty = { ...session("a", "E:/x"), lastMessageAt: "" };
    expect(sessionActivityAt(empty)).toBe("2026-08-16T10:00:00.000Z");
  });
});

describe("sessionRowMark", () => {
  // The chat the reader is looking at states its own condition on screen.
  it("marks nothing in the active pane", () => {
    expect(sessionRowMark("running", false, false)).toBeNull();
    expect(sessionRowMark("waiting", false, false)).toBeNull();
    expect(sessionRowMark("idle", false, true)).toBeNull();
  });

  // A parked chat used to get the animated "Working…" mark, which claimed the
  // agent was burning time while it actually waited for an answer.
  it("never marks a parked chat as running", () => {
    expect(sessionRowMark("waiting", true, false)).toBe("waiting");
    expect(sessionRowMark("waiting", true, true)).toBe("waiting");
  });

  it("keeps running and unseen distinct", () => {
    expect(sessionRowMark("running", true, false)).toBe("running");
    expect(sessionRowMark("idle", true, true)).toBe("unseen");
    expect(sessionRowMark("idle", true, false)).toBeNull();
  });
});
