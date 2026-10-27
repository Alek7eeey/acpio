// @vitest-environment jsdom
// The request queue above the composer: every row is editable, deletable and
// movable before the queue hands it over — the order of the rows is the order
// the agent gets them in.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@acpio/shared";
import { useAppStore } from "../lib/store";
import { I18nProvider } from "../lib/i18n";
import { PromptQueueBar } from "./PromptQueueBar";

const apiMock = vi.hoisted(() => ({
  prompt: vi.fn(async (...args: unknown[]) => ({ ok: true, args })),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));

const queue = [
  { id: "q1", text: "First queued", sessionId: "s1" },
  { id: "q2", text: "Second queued", sessionId: "s1" },
  { id: "q3", text: "Third queued", sessionId: "s1" },
];

beforeEach(() => {
  useAppStore.setState({
    settings: DEFAULT_SETTINGS,
    promptQueue: queue.map((item) => ({ ...item })),
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The page hands the bar a fresh list on every queue change — the harness
 *  subscribes the same way, so a store write is a re-render here too. */
function Harness() {
  const items = useAppStore((s) => s.promptQueue);
  return <PromptQueueBar items={items} />;
}

function renderBar() {
  return render(
    <I18nProvider>
      <Harness />
    </I18nProvider>,
  );
}

const order = () => useAppStore.getState().promptQueue.map((item) => item.text);

/** A vertical drag as the browser reports it: press, move past the threshold,
 *  release over the row the point test answers with. */
function dragRow(from: HTMLElement, over: HTMLElement, clientY: number) {
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    writable: true,
    value: () => [over],
  });
  // jsdom has no layout: the drop side is read off a fake rect.
  over.getBoundingClientRect = () =>
    ({ top: 0, height: 40, bottom: 40, left: 0, right: 0, width: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  try {
    fireEvent.pointerDown(from, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: "mouse", clientY });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "mouse", clientY });
  } finally {
    Reflect.deleteProperty(document, "elementsFromPoint");
  }
}

describe("PromptQueueBar", () => {
  it("lists every queued request with its count", () => {
    renderBar();
    for (const item of queue) expect(screen.getByText(item.text)).toBeTruthy();
    expect(screen.getByText(/3/)).toBeTruthy();
  });

  it("deletes a request from the queue", async () => {
    renderBar();
    const row = screen.getByText("Second queued").closest("[data-queue-id]") as HTMLElement;
    const remove = within(row).getAllByRole("button")[2]!;
    await userEvent.click(remove);
    expect(order()).toEqual(["First queued", "Third queued"]);
    expect(screen.queryByText("Second queued")).toBeNull();
  });

  it("rewrites a request in place", async () => {
    renderBar();
    const row = screen.getByText("First queued").closest("[data-queue-id]") as HTMLElement;
    const edit = within(row).getAllByRole("button")[1]!;
    await userEvent.click(edit);

    const field = within(row).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Rewritten request{Enter}");

    expect(useAppStore.getState().promptQueue[0]!.text).toBe("Rewritten request");
    expect(screen.getByText("Rewritten request")).toBeTruthy();
  });

  it("keeps the old text when an edit is cancelled with Escape", async () => {
    renderBar();
    const row = screen.getByText("First queued").closest("[data-queue-id]") as HTMLElement;
    await userEvent.click(within(row).getAllByRole("button")[1]!);
    const field = within(row).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "Half-typed{Escape}");
    expect(useAppStore.getState().promptQueue[0]!.text).toBe("First queued");
  });

  it("hands the request over at once from the send-now arrow", async () => {
    renderBar();
    const row = screen.getByText("First queued").closest("[data-queue-id]") as HTMLElement;
    const send = within(row).getAllByRole("button")[3]!;
    await userEvent.click(send);
    expect(apiMock.prompt).toHaveBeenCalledTimes(1);
    expect(apiMock.prompt.mock.calls[0]![1]).toBe("First queued");
    expect(order()).toEqual(["Second queued", "Third queued"]);
  });

  it("moves a request to the slot it is dragged to", async () => {
    const { container } = renderBar();
    const rowOf = (id: string) => container.querySelector(`[data-queue-id="${id}"]`) as HTMLElement;
    // The grip is the row's first button: a press on the text itself would
    // select it instead of moving the row.
    dragRow(within(rowOf("q1")).getAllByRole("button")[0]!, rowOf("q3"), 35);
    expect(order()).toEqual(["Second queued", "Third queued", "First queued"]);
  });
});
