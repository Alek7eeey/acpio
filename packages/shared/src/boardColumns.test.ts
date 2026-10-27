import { describe, it, expect } from "vitest";
import {
  boardColumn,
  boardColumnHome,
  boardColumnOf,
  boardColumnsInOrder,
  compareBoardTasks,
  defaultBoardColumns,
  type BoardColumnDto,
  type BoardTaskPlacement,
} from "./index.js";

/** The four homes a board starts with, in display order. */
const homes = defaultBoardColumns();

/** A board task row with the placement left open. */
function task(patch: Partial<BoardTaskPlacement> = {}): BoardTaskPlacement {
  return { status: "idle", startedAt: null, doneAt: null, cwd: "/p/app", ...patch };
}

/** A column of the reader's own. */
function column(patch: Partial<BoardColumnDto>): BoardColumnDto {
  return {
    id: "col-review",
    title: "На ревью",
    kind: "manual",
    anchor: null,
    home: false,
    sortOrder: 10,
    sortMode: "manual",
    acceptsPrompt: true,
    keepOnRun: false,
    ...patch,
  };
}

describe("boardColumnsInOrder", () => {
  it("falls back to the four homes for a board that carries no columns", () => {
    expect(boardColumnsInOrder([]).map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "wait",
      "done",
    ]);
    expect(boardColumnsInOrder(null).map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "wait",
      "done",
    ]);
  });

  it("orders by sortOrder, whatever order the rows arrive in", () => {
    const shuffled = [homes[2], homes[0], homes[3], homes[1]];
    expect(boardColumnsInOrder(shuffled).map((c) => c.id)).toEqual([
      "todo",
      "progress",
      "wait",
      "done",
    ]);
  });
});

describe("boardColumnOf", () => {
  // The board from before columns could be edited: every card is where the
  // lifecycle puts it, which is the behavior custom columns must preserve.
  it("reproduces boardColumn() on the four homes alone", () => {
    const cases: BoardTaskPlacement[] = [
      task({ status: "idle", startedAt: null }),
      task({ status: "running", startedAt: "2026-09-20T10:00:00.000Z" }),
      task({ status: "idle", startedAt: "2026-09-20T10:00:00.000Z" }),
      task({ status: "waiting", startedAt: "2026-09-20T10:00:00.000Z" }),
      task({ status: "error", startedAt: "2026-09-20T10:00:00.000Z" }),
      task({ status: "closed", startedAt: "2026-09-20T10:00:00.000Z" }),
      task({ status: "running", doneAt: "2026-09-20T11:00:00.000Z" }),
      task({ status: "idle", startedAt: "2026-09-20T10:00:00.000Z", doneAt: "2026-09-20T11:00:00.000Z" }),
    ];
    for (const row of cases) {
      expect(boardColumnOf(row, homes)).toBe(boardColumn(row));
    }
  });

  it("keeps a card in the lane the reader put it in, whatever the lifecycle says", () => {
    const columns = [...homes, column({})];
    // A finished turn would land in Wait; the reader parked it on its own lane.
    const parked = task({
      status: "idle",
      startedAt: "2026-09-20T10:00:00.000Z",
      boardColumnId: "col-review",
    });
    expect(boardColumnOf(parked, columns)).toBe("col-review");
    // A live turn does not move it either — only a placed card knows better.
    expect(boardColumnOf({ ...parked, status: "running" }, columns)).toBe("col-review");
  });

  it("ignores a placement whose column was deleted", () => {
    const gone = task({ boardColumnId: "col-gone", startedAt: "2026-09-20T10:00:00.000Z" });
    expect(boardColumnOf(gone, homes)).toBe("wait");
  });

  // A lane the reader adds is a place, not a condition: it holds what was put
  // in it and claims nothing, so a card of any stage falls back to its home.
  it("never claims a card for a lane the reader added", () => {
    const columns = [...homes, column({ anchor: "wait" })];
    const finished = task({ status: "idle", startedAt: "2026-09-20T10:00:00.000Z" });
    const question = task({ status: "waiting", startedAt: "2026-09-20T10:00:00.000Z" });
    const failed = task({ status: "error", startedAt: "2026-09-20T10:00:00.000Z" });
    for (const row of [finished, question, failed]) {
      expect(boardColumnOf(row, columns)).toBe("wait");
    }
    // Only a hand placement puts a card there.
    expect(boardColumnOf({ ...finished, boardColumnId: "col-review" }, columns)).toBe(
      "col-review",
    );
  });

  it("never answers with a column the board does not have", () => {
    const columns = [...homes, column({})];
    const ids = new Set(columns.map((c) => c.id));
    for (const status of ["idle", "running", "waiting", "error", "closed"] as const) {
      expect(ids.has(boardColumnOf(task({ status }), columns))).toBe(true);
    }
    // A board whose Todo home is gone still answers with a column of its own.
    const broken = homes.filter((c) => c.id !== "todo");
    expect(broken.map((c) => c.id)).toContain(boardColumnOf(task(), broken));
  });

  it("finds the home of a stage by the stage, not by the position", () => {
    const reordered = [...homes].map((c) => ({ ...c, sortOrder: 9 - c.sortOrder }));
    const order = boardColumnsInOrder(reordered);
    expect(order.map((c) => c.id)).toEqual(["done", "wait", "progress", "todo"]);
    expect(boardColumnHome(order, "todo")?.id).toBe("todo");
  });
});

describe("compareBoardTasks", () => {
  const early = { sortOrder: 0, createdAt: "2026-09-20T09:00:00.000Z", updatedAt: "2026-09-20T12:00:00.000Z", doneAt: null };
  const late = { sortOrder: 1, createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T11:00:00.000Z", doneAt: "2026-09-20T11:00:00.000Z" };

  it("orders a manual column by sortOrder, the way the arrows write it", () => {
    expect([late, early].sort(compareBoardTasks("manual")).map((r) => r.sortOrder)).toEqual([0, 1]);
  });

  it("orders the logs newest first by the stamp they are about", () => {
    expect([early, late].sort(compareBoardTasks("done")).map((r) => r.sortOrder)).toEqual([1, 0]);
    expect([early, late].sort(compareBoardTasks("updated")).map((r) => r.sortOrder)).toEqual([0, 1]);
    expect([early, late].sort(compareBoardTasks("created")).map((r) => r.sortOrder)).toEqual([1, 0]);
  });
});
