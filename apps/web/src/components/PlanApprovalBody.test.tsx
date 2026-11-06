// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { coercePlanPayload } from "./PlanApprovalBody";

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
});
