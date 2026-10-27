// @vitest-environment jsdom
// The board's column editor: the four stage homes are always listed and never
// deletable, a lane of the reader's own is added, restaged and deleted here —
// every edit going through the same store action the page uses.

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
  rule: null,
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
  it("lists the four stage homes plus the reader's lane, homes undeletable", () => {
    const { container } = renderDialog();
    const rows = container.querySelectorAll("[data-column-id]");
    expect(rows.length).toBe(5);

    const todo = container.querySelector('[data-column-id="todo"]') as HTMLElement;
    expect(todo.querySelector("[data-column-home]")).toBeTruthy();
    expect(todo.querySelector("[data-column-delete]")).toBeNull();

    const lane = container.querySelector('[data-column-id="col-review"]') as HTMLElement;
    expect(lane.querySelector("[data-column-home]")).toBeNull();
    expect(lane.querySelector("[data-column-delete]")).toBeTruthy();
  });

  it("restages a lane of the reader's own", async () => {
    const { container } = renderDialog();
    const lane = container.querySelector('[data-column-id="col-review"]') as HTMLElement;
    const stage = lane.querySelectorAll("select")[0] as HTMLSelectElement;
    fireEvent.change(stage, { target: { value: "wait" } });

    expect(apiMock.updateBoardColumn).toHaveBeenCalledWith("b1", "col-review", { anchor: "wait" });
  });

  it("deletes a lane through the same action the page uses", async () => {
    const { container } = renderDialog();
    const remove = container.querySelector(
      '[data-column-id="col-review"] [data-column-delete]',
    ) as HTMLElement;
    await userEvent.click(remove);
    expect(apiMock.deleteBoardColumn).toHaveBeenCalledWith("b1", "col-review");
  });

  it("adds a lane of the reader's own", async () => {
    const { container } = renderDialog();
    const input = container.querySelector("[data-new-column-title]") as HTMLInputElement;
    await userEvent.type(input, "Deferred");
    await userEvent.click(container.querySelector("[data-add-column]") as HTMLElement);

    expect(apiMock.addBoardColumn).toHaveBeenCalledTimes(1);
    const [boardId, body] = apiMock.addBoardColumn.mock.calls[0]!;
    expect(boardId).toBe("b1");
    expect(body).toMatchObject({ title: "Deferred", kind: "manual", anchor: null });
  });

  it("adds a rule lane with the stage and the condition it claims", async () => {
    const { container } = renderDialog();
    const input = container.querySelector("[data-new-column-title]") as HTMLInputElement;
    await userEvent.type(input, "Finished");
    // The add form's own selects: kind, stage, (condition once kind is auto).
    const addBox = container.querySelector("[data-new-column-title]")!.parentElement!;
    const kind = addBox.querySelectorAll("select")[0] as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: "auto" } });
    const stage = addBox.querySelectorAll("select")[1] as HTMLSelectElement;
    fireEvent.change(stage, { target: { value: "wait" } });
    await userEvent.click(container.querySelector("[data-add-column]") as HTMLElement);

    const body = apiMock.addBoardColumn.mock.calls[0]![1];
    expect(body).toMatchObject({ title: "Finished", kind: "auto", anchor: "wait" });
    expect(body.rule).toEqual({ stage: "wait" });
  });
});
