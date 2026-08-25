import { describe, it, expect } from "vitest";
import type { SessionDto } from "@acpio/shared";
import { groupByFolder, sessionActivityAt } from "./ChatSidebar";

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
