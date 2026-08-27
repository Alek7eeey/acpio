import { describe, expect, it } from "vitest";
import {
  elicitationContentFromUiAnswers,
  elicitationResponseFromUiOutcome,
  elicitationSchemaToQuestionPayload,
} from "./elicitationForm.js";

describe("elicitationSchemaToQuestionPayload", () => {
  it("maps OMP ask review choices", () => {
    const payload = elicitationSchemaToQuestionPayload("Which review should run?", {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Which review should run?",
          oneOf: [
            { const: "Bugbot", title: "Bugbot (/review-bugbot)" },
            { const: "Security", title: "Security Review (/review-security)" },
          ],
        },
        q0__other: { type: "string", title: "Other" },
      },
    });
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0]?.options.map((o) => o.id)).toEqual(["Bugbot", "Security"]);
    expect(payload.questions[0]?.freeTextField).toBe("q0__other");
  });

  it("maps select/input/confirm value schemas", () => {
    const select = elicitationSchemaToQuestionPayload("Pick one", {
      type: "object",
      properties: { value: { type: "string", enum: ["a", "b"] } },
      required: ["value"],
    });
    expect(select.questions[0]?.options.map((o) => o.id)).toEqual(["a", "b"]);

    const input = elicitationSchemaToQuestionPayload("Name", {
      type: "object",
      properties: { value: { type: "string", title: "Workspace name", description: "hint" } },
      required: ["value"],
    });
    expect(input.questions[0]?.textInput).toBe(true);

    const confirm = elicitationSchemaToQuestionPayload("Continue?", {
      type: "object",
      properties: { value: { type: "boolean" } },
      required: ["value"],
    });
    expect(confirm.questions[0]?.booleanChoice).toBe(true);
  });
});

describe("elicitationContentFromUiAnswers", () => {
  it("uses other text exclusively for single-select", () => {
    const payload = elicitationSchemaToQuestionPayload("Pick", {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Pick",
          oneOf: [{ const: "Bugbot", title: "Bugbot" }],
        },
        q0__other: { type: "string", title: "Other" },
      },
    });
    const content = elicitationContentFromUiAnswers(payload, [
      { questionId: "q0", selectedOptionIds: ["Bugbot"], freeText: "custom" },
    ]);
    expect(content).toEqual({ q0__other: "custom" });
  });

  it("returns selected option when no custom text", () => {
    const payload = elicitationSchemaToQuestionPayload("Pick", {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Pick",
          oneOf: [{ const: "Security", title: "Security" }],
        },
        q0__other: { type: "string", title: "Other" },
      },
    });
    const content = elicitationContentFromUiAnswers(payload, [
      { questionId: "q0", selectedOptionIds: ["Security"] },
    ]);
    expect(content).toEqual({ q0: "Security" });
  });
});

describe("elicitationResponseFromUiOutcome", () => {
  it("maps skip to cancel and answered to accept", () => {
    const payload = elicitationSchemaToQuestionPayload("Continue?", {
      type: "object",
      properties: { value: { type: "boolean" } },
    });
    expect(elicitationResponseFromUiOutcome(payload, { outcome: { outcome: "skipped" } })).toEqual({
      action: "cancel",
    });
    expect(
      elicitationResponseFromUiOutcome(payload, {
        outcome: {
          outcome: "answered",
          answers: [{ questionId: "value", selectedOptionIds: ["true"] }],
        },
      }),
    ).toEqual({ action: "accept", content: { value: true } });
  });
});
