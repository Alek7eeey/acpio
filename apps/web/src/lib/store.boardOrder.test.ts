// @vitest-environment jsdom
// The board's column writes each answer with the whole board, so two presses on
// the editor's arrows run two round trips at once. The older answer must not win
// — it would put the strip back where it was and the moved column would jump.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  defaultBoardColumns,
  type BoardColumnDto,
  type BoardDto,
} from "@acpio/shared";

const apiMock = vi.hoisted(() => ({ reorderBoardColumns: vi.fn() }));
vi.mock("./api", () => ({ api: apiMock }));

import { useAppStore } from "./store";

const lane = (id: string, title: string, sortOrder: number): BoardColumnDto => ({
  id,
  title,
  kind: "manual",
  anchor: null,
  home: false,
  sortOrder,
  sortMode: "manual",
  acceptsPrompt: true,
  keepOnRun: false,
});

const board: BoardDto = {
  id: "b1",
  name: "Delivery",
  folders: [],
  folderTags: {},
  folderAutoRun: {},
  columns: [
    ...defaultBoardColumns(),
    lane("col-a", "Review", 4),
    lane("col-b", "Blocked", 5),
  ],
  sortOrder: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
};

/** The board a write of `ids` would answer with — the server's view, at its turn. */
function answer(ids: string[]): BoardDto {
  const order = new Map(ids.map((id, index) => [id, index]));
  return {
    ...board,
    columns: board.columns
      .map((column) =>
        order.has(column.id) ? { ...column, sortOrder: order.get(column.id)! } : column,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

const order = () => useAppStore.getState().boards[0]!.columns.map((column) => column.id);

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ settings: DEFAULT_SETTINGS, boards: [board] });
});

describe("two column writes in flight", () => {
  it("keeps the newer order when the older answer lands last", async () => {
    const settle: Array<() => void> = [];
    apiMock.reorderBoardColumns.mockImplementation(
      (_id: string, ids: string[]) =>
        new Promise((resolve) => settle.push(() => resolve(answer(ids)))),
    );

    // Blocked and Review swap twice: the reader pressed ↓ twice on one column.
    void useAppStore
      .getState()
      .reorderBoardColumns("b1", ["todo", "progress", "wait", "col-b", "done", "col-a"]);
    const second = useAppStore
      .getState()
      .reorderBoardColumns("b1", ["todo", "progress", "wait", "col-b", "col-a", "done"]);
    expect(order().slice(3)).toEqual(["col-b", "col-a", "done"]);

    // The first round trip answers last: it must be dropped, not the second.
    settle[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(order().slice(3)).toEqual(["col-b", "col-a", "done"]);

    settle[1]!();
    await second;
    expect(order().slice(3)).toEqual(["col-b", "col-a", "done"]);
  });

  // The server broadcasts every column write too, and that frame carries the
  // board read at its own turn — the older order, arriving while our newer press
  // is still on the wire. It must not put the strip back either.
  it("ignores a board frame that lands while our own write is out", async () => {
    let release!: () => void;
    apiMock.reorderBoardColumns.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(answer(["todo", "progress", "wait", "col-b", "col-a", "done"])))),
    );

    const press = useAppStore
      .getState()
      .reorderBoardColumns("b1", ["todo", "progress", "wait", "col-b", "col-a", "done"]);
    await Promise.resolve();
    const moved = order();

    useAppStore.getState().handleWsEvent({
      type: "board.updated",
      board: answer(["todo", "progress", "wait", "col-a", "col-b", "done"]),
    });
    expect(order()).toEqual(moved);

    release();
    await press;
    expect(order().slice(3)).toEqual(["col-b", "col-a", "done"]);
  });
});
