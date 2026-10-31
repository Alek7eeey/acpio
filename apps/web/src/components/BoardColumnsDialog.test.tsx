// @vitest-environment jsdom
// The board's column editor: the four stage homes are always listed and never
// deletable, a lane of the reader's own is added and deleted here — every edit
// going through the same store action the page uses. A column is a place, never
// a condition: the editor offers no stage or rule to claim cards by.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DEFAULT_SETTINGS,
  defaultBoardColumns,
  type BoardColumnDto,
  type BoardDto,
} from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { BoardColumnsDialog } from "./BoardColumnsDialog";

const review: BoardColumnDto = {
  id: "col-review",
  title: "Review",
  kind: "manual",
  anchor: null,
  home: false,
  sortOrder: 4,
  sortMode: "manual",
  acceptsPrompt: true,
  keepOnRun: false,
};

const board: BoardDto = {
  id: "b1",
  name: "Delivery",
  folders: ["/projects/app"],
  folderTags: {},
  folderAutoRun: {},
  columns: [...defaultBoardColumns(), review],
  sortOrder: 0,
  createdAt: "2026-09-20T10:00:00.000Z",
};

const apiMock = vi.hoisted(() => ({
  addBoardColumn: vi.fn(async (id: string, body: Record<string, unknown>) => ({
    id,
    columns: [],
    ...body,
  })),
  updateBoardColumn: vi.fn(async (id: string, columnId: string, patch: Record<string, unknown>) => ({
    id,
    columns: [{ id: "col-review", title: "Review", patch }],
  })),
  deleteBoardColumn: vi.fn(async (id: string) => ({ id, columns: [] })),
  reorderBoardColumns: vi.fn(async (id: string) => ({ id, columns: [] })),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

beforeEach(() => {
  useAppStore.setState({ settings: DEFAULT_SETTINGS, boards: [board] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  return render(
    <I18nProvider>
      <BoardColumnsDialog open board={useAppStore.getState().boards[0]!} onClose={() => {}} />
    </I18nProvider>,
  );
}

describe("BoardColumnsDialog", () => {
  it("lists the four stage homes plus the reader's lane, homes marked as stages", () => {
    const { container } = renderDialog();
    const rows = container.querySelectorAll("[data-column-id]");
    expect(rows.length).toBe(5);

    const todo = container.querySelector('[data-column-id="todo"]') as HTMLElement;
    expect(todo.querySelector("[data-column-home]")).toBeTruthy();

    const lane = container.querySelector('[data-column-id="col-review"]') as HTMLElement;
    expect(lane.querySelector("[data-column-home]")).toBeNull();
  });

  // A home is where a stage puts its cards, so the editor never offers to take
  // it away: the delete is refused for it and works for a lane.
  it("deletes a lane of the reader's through the page's action, never a home", async () => {
    const { container } = renderDialog();
    const remove = container.querySelector("[data-column-delete]") as HTMLButtonElement;

    // The editor opens on the first column, a home.
    expect(remove.disabled).toBe(true);
    await userEvent.click(container.querySelector('[data-column-id="wait"]') as HTMLElement);
    expect(remove.disabled).toBe(true);
    expect(apiMock.deleteBoardColumn).not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('[data-column-id="col-review"]') as HTMLElement);
    expect(remove.disabled).toBe(false);
    await userEvent.click(remove);
    expect(apiMock.deleteBoardColumn).toHaveBeenCalledWith("b1", "col-review");
  });

  // The rule the editor lost: a column never claims cards by a condition, so a
  // lane answers only for its title, its order and its behavior.
  it("asks a lane nothing about a stage or a rule", async () => {
    const { container } = renderDialog();
    const settings = () => container.querySelector("[data-column-settings]") as HTMLElement;

    await userEvent.click(container.querySelector('[data-column-id="todo"]') as HTMLElement);
    expect(settings().querySelectorAll("select").length).toBe(1);
    expect(settings().querySelectorAll("input[type='checkbox']").length).toBe(1);

    await userEvent.click(container.querySelector('[data-column-id="col-review"]') as HTMLElement);
    expect(settings().querySelectorAll("select").length).toBe(1);
    expect(settings().querySelectorAll("input[type='checkbox']").length).toBe(2);

    const addBox = container.querySelector("[data-new-column-title]")!.parentElement!;
    expect(addBox.querySelectorAll("select").length).toBe(0);
  });

  it("renames the picked column through the same action the page uses", async () => {
    const { container } = renderDialog();
    await userEvent.click(container.querySelector('[data-column-id="col-review"]') as HTMLElement);
    const input = container.querySelector("[data-column-settings] input") as HTMLInputElement;
    expect(input.value).toBe("Review");

    fireEvent.change(input, { target: { value: "Deferred" } });
    fireEvent.blur(input);
    expect(apiMock.updateBoardColumn).toHaveBeenCalledWith("b1", "col-review", {
      title: "Deferred",
    });
  });

  it("adds a lane of the reader's own, by its title alone", async () => {
    const { container } = renderDialog();
    const input = container.querySelector("[data-new-column-title]") as HTMLInputElement;
    await userEvent.type(input, "Deferred");
    await userEvent.click(container.querySelector("[data-add-column]") as HTMLElement);

    expect(apiMock.addBoardColumn).toHaveBeenCalledTimes(1);
    const [boardId, body] = apiMock.addBoardColumn.mock.calls[0]!;
    expect(boardId).toBe("b1");
    // A lane is a place: nothing about a stage, a kind or a rule travels with it.
    expect(body).toEqual({ title: "Deferred" });
  });
});
