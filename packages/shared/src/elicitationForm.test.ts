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

  it("carries oneOf option descriptions onto the mapped options", () => {
    const payload = elicitationSchemaToQuestionPayload("Publish the review?", {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Publish the review?",
          oneOf: [
            {
              const: "comment",
              title: "Comment in PR",
              description: "Posts a comment in the PR thread.",
            },
            { const: "skip", title: "Do not publish" },
          ],
        },
      },
    });
    const options = payload.questions[0]?.options ?? [];
    expect(options[0]).toMatchObject({
      id: "comment",
      label: "Comment in PR",
      description: "Posts a comment in the PR thread.",
    });
    expect(options[1]?.description).toBeUndefined();
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

  it("keeps the picked list and the typed words for multi-select", () => {
    const payload = elicitationSchemaToQuestionPayload("Pick", {
      type: "object",
      properties: {
        q0: {
          type: "array",
          title: "Pick",
          items: { anyOf: [{ const: "Bugbot", title: "Bugbot" }] },
        },
        q0__other: { type: "string", title: "Other" },
      },
    });
    const content = elicitationContentFromUiAnswers(payload, [
      { questionId: "q0", selectedOptionIds: ["Bugbot"], freeText: "both" },
    ]);
    expect(content).toEqual({ q0: ["Bugbot"], q0__other: "both" });
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
  it("maps OMP askDialog Review Mode choice onto q0", () => {
    const payload = elicitationSchemaToQuestionPayload("Review Mode", {
      type: "object",
      properties: {
        q0: {
          type: "string",
          title: "Review Mode",
          oneOf: [
            { const: "1. Review against a base branch (PR Style)", title: "1. Review against a base branch (PR Style)" },
            { const: "2. Review uncommitted changes", title: "2. Review uncommitted changes" },
          ],
        },
        q0__other: { type: "string", title: "Other" },
      },
    });
    expect(
      elicitationResponseFromUiOutcome(payload, {
        outcome: {
          outcome: "answered",
          answers: [{ questionId: "q0", selectedOptionIds: ["2. Review uncommitted changes"] }],
        },
      }),
    ).toEqual({ action: "accept", content: { q0: "2. Review uncommitted changes" } });
  });

  it("still accepts a nested UI envelope", () => {
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
