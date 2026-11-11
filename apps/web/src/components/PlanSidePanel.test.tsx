// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { PlanSidePanel } from "./PlanSidePanel";
import type { PlanPayload } from "./PlanApprovalBody";

const PLAN: PlanPayload = {
  name: "План как файл",
  overview: "План уезжает в файл.",
  path: ".acpio/plan.md",
  stage: "draft",
  pacing: "whole",
  todos: [
    { id: "e0", content: "Прочитать код", status: "completed" },
    { id: "e1", content: "Написать модуль", status: "in_progress" },
    { id: "e2", content: "Тесты", status: "pending" },
  ],
};

function renderPanel(
  plan: PlanPayload,
  props: Partial<Parameters<typeof PlanSidePanel>[0]> = {},
) {
  return render(
    <I18nProvider>
      <PlanSidePanel plan={plan} open onClose={() => {}} {...props} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("PlanSidePanel", () => {
  it("shows the stage, the file and how far the steps got", () => {
    renderPanel(PLAN);
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText(".acpio/plan.md")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });

  it("approves a draft with the panel's own button — the only answer there", () => {
    const onApprove = vi.fn();
    renderPanel(PLAN, { onApprove });
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    // Reworking is not an answer the panel offers: approving or nothing.
    expect(screen.queryByText("Rework")).toBeNull();
  });

  it("asks twice for nothing: the button is dead while the approval is in flight", () => {
    const onApprove = vi.fn();
    renderPanel(PLAN, { onApprove, approving: true });
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("switches the pace of an approved plan, and offers no approval again", () => {
    const onPacing = vi.fn();
    renderPanel({ ...PLAN, stage: "applying" }, { onPacing });
    expect(screen.getByText("Implementing")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
    fireEvent.click(screen.getByText("One at a time"));
    expect(onPacing).toHaveBeenCalledWith("step");
  });

  it("offers the pace before the work starts too — it is the pace it will start at", () => {
    const onPacing = vi.fn();
    renderPanel(PLAN, { onPacing, onApprove: () => {} });
    expect(screen.getByText("Pace")).toBeTruthy();
    fireEvent.click(screen.getByText("One at a time"));
    expect(onPacing).toHaveBeenCalledWith("step");
  });

  it("keeps the waiting card in charge: answer it, or turn it down", () => {
    const onAccept = vi.fn();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    renderPanel(PLAN, { pending: true, onAccept, onReject, onApprove });
    expect(screen.getByText("Awaiting")).toBeTruthy();
    // The card's own accept is the approval: one approve button, not two.
    expect(screen.getAllByText("Approve")).toHaveLength(1);
    fireEvent.click(screen.getByText("Reject"));
    expect(onReject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Approve"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("lets the reader pick the pace while the card still waits", () => {
    const onPacing = vi.fn();
    renderPanel(PLAN, { pending: true, onAccept: () => {}, onReject: () => {}, onPacing });
    // The pace is what the approval will start at — so it is asked before it.
    expect(screen.getByText("Pace")).toBeTruthy();
    fireEvent.click(screen.getByText("One at a time"));
    expect(onPacing).toHaveBeenCalledWith("step");
  });

  it("edits the plan file by hand: the file's own text, saved as typed", async () => {
    const onReadText = vi.fn(async () => "---\nstage: draft\n---\n## Steps\n- [ ] One\n");
    const onWriteText = vi.fn(async () => {});
    renderPanel(PLAN, { onReadText, onWriteText });

    fireEvent.click(screen.getByLabelText("Edit plan"));
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toContain("- [ ] One");

    fireEvent.change(box, { target: { value: "---\nstage: draft\n---\n## Steps\n- [ ] Two\n" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(onWriteText).toHaveBeenCalledWith(expect.stringContaining("- [ ] Two")));
    // Saved and closed: the panel is back to drawing the plan.
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("opens the editor at once and never greys the pencil out while the file is on its way", async () => {
    // Reading the file is the server's business; the reader's button is not the
    // place to wait for it. A slow read used to leave the pencil disabled for as
    // long as the agent was busy, which read as "the plan cannot be edited".
    let land: (text: string) => void = () => {};
    const onReadText = vi.fn(
      () => new Promise<string>((resolve) => {
        land = resolve;
      }),
    );
    renderPanel(PLAN, { onReadText, onWriteText: async () => {} });

    const pencil = screen.getByLabelText("Edit plan") as HTMLButtonElement;
    expect(pencil.disabled).toBe(false);
    fireEvent.click(pencil);
    // The editor is already there, empty until the text lands — and the reader
    // can start typing right away: what they type is not overwritten.
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    expect(box.value).toBe("");
    land("---\nstage: draft\n---\n## Steps\n- [ ] One\n");
    await waitFor(() => expect(box.value).toContain("- [ ] One"));
  });

  it("keeps what the reader typed while the file was still on its way", async () => {
    let land: (text: string) => void = () => {};
    const onReadText = () =>
      new Promise<string>((resolve) => {
        land = resolve;
      });
    renderPanel(PLAN, { onReadText, onWriteText: async () => {} });

    fireEvent.click(screen.getByLabelText("Edit plan"));
    const box = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "my own steps" } });
    land("---\nstage: draft\n---\n## Steps\n- [ ] One\n");
    await waitFor(() => expect(box.value).toBe("my own steps"));
  });

  it("offers no editor for a plan with no file behind it", () => {
    const { plan: _ignored, ...bare } = PLAN;
    renderPanel(
      { ...bare, path: undefined, stage: undefined },
      { onReadText: async () => "", onWriteText: async () => {} },
    );
    expect(screen.queryByLabelText("Edit plan")).toBeNull();
  });

  it("draws no switches for a plan another agent published", () => {
    const onApprove = vi.fn();
    const { plan: _ignored, ...bare } = PLAN;
    renderPanel({ ...bare, path: undefined, stage: undefined }, { onApprove });
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Pace")).toBeNull();
  });

  it("leaves the chat column for the body when it goes full screen", () => {
    // The chat pane is its own stacking context, so a fixed panel inside it is
    // painted under the sidebar and the app header — full screen means the body.
    const { container } = renderPanel(PLAN);
    const inColumn = () => container.contains(screen.getByLabelText("Outline"));
    expect(inColumn()).toBe(true);
    fireEvent.click(screen.getByLabelText("Expand to full screen"));
    expect(inColumn()).toBe(false);
    expect(screen.getByLabelText("Outline").parentElement).toBe(document.body);
    fireEvent.click(screen.getByLabelText("Exit full screen"));
    expect(inColumn()).toBe(true);
  });
});
