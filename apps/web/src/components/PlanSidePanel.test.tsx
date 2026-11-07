// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByText("Approve and start"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    // Reworking is not an answer the panel offers: approving or nothing.
    expect(screen.queryByText("Rework")).toBeNull();
  });

  it("asks twice for nothing: the button is dead while the approval is in flight", () => {
    const onApprove = vi.fn();
    renderPanel(PLAN, { onApprove, approving: true });
    fireEvent.click(screen.getByText("Approve and start"));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("switches the pace of an approved plan, and offers no approval again", () => {
    const onPacing = vi.fn();
    renderPanel({ ...PLAN, stage: "applying" }, { onPacing });
    expect(screen.getByText("Implementing")).toBeTruthy();
    expect(screen.queryByText("Approve and start")).toBeNull();
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
    expect(screen.getAllByText("Approve and start")).toHaveLength(1);
    fireEvent.click(screen.getByText("Reject"));
    expect(onReject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Approve and start"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("draws no switches for a plan another agent published", () => {
    const onApprove = vi.fn();
    const { plan: _ignored, ...bare } = PLAN;
    renderPanel({ ...bare, path: undefined, stage: undefined }, { onApprove });
    expect(screen.queryByText("Approve and start")).toBeNull();
    expect(screen.queryByText("Pace")).toBeNull();
  });
});
