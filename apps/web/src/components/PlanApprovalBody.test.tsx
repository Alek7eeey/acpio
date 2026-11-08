// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "../lib/i18n";
import { PlanApprovalBody, coercePlanPayload } from "./PlanApprovalBody";

afterEach(cleanup);

describe("coercePlanPayload", () => {
  it("carries the file plan's stage, pace and path to the panel", () => {
    const payload = coercePlanPayload({
      name: "План как файл",
      overview: "Одна строка.",
      path: ".acpio/plan.md",
      stage: "applying",
      pacing: "step",
      entries: [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "in_progress" },
      ],
    });
    expect(payload).toMatchObject({
      name: "План как файл",
      overview: "Одна строка.",
      path: ".acpio/plan.md",
      stage: "applying",
      pacing: "step",
      todos: [
        { id: "entry-0", content: "Read the code", status: "completed" },
        { id: "entry-1", content: "Fix it", status: "in_progress" },
      ],
    });
  });

  it("leaves them out for a plan published by another agent", () => {
    const payload = coercePlanPayload({ name: "Plan", overview: "Ov" });
    expect(payload?.stage).toBeUndefined();
    expect(payload?.path).toBeUndefined();
    expect(payload?.pacing).toBeUndefined();
  });

  it("carries the problem the plan solves", () => {
    const payload = coercePlanPayload({
      name: "План как файл",
      problem: " Панель не редактируется, пока идёт работа. ",
      overview: "Читать один ряд вместо всей переписки.",
    });
    expect(payload?.problem).toBe("Панель не редактируется, пока идёт работа.");
  });
});

describe("PlanApprovalBody", () => {
  const draw = (payload: Parameters<typeof PlanApprovalBody>[0]["payload"]) =>
    render(
      <I18nProvider>
        <PlanApprovalBody payload={payload} fallbackTitle="Plan" />
      </I18nProvider>,
    );

  it("puts the problem above the solution, both labelled", () => {
    draw({ name: "Plan", problem: "The panel freezes", overview: "Read one row" });
    const problem = screen.getByText("Problem");
    const solution = screen.getByText("Solution");
    expect(problem).toBeTruthy();
    expect(
      problem.compareDocumentPosition(solution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("The panel freezes")).toBeTruthy();
    expect(screen.getByText("Read one row")).toBeTruthy();
  });

  it("draws a plan with no problem as it always did: one plain paragraph", () => {
    draw({ name: "Plan", overview: "Read one row" });
    expect(screen.queryByText("Problem")).toBeNull();
    expect(screen.queryByText("Solution")).toBeNull();
    expect(screen.getByText("Read one row")).toBeTruthy();
  });
});
