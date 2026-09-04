import { describe, expect, it } from "vitest";
import type { MessagePartDto } from "@acpio/shared";
import { finalAnswerPart, lastTextPart, stepsPartsStillLive, turnAnswerVisible, turnStillHasLiveTools } from "./assistantTurnTimeline.js";

function part(
  type: MessagePartDto["type"],
  order: number,
  payload: Record<string, unknown>,
): MessagePartDto {
  return {
    id: `${type}-${order}`,
    messageId: "m1",
    type,
    order,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("stepsPartsStillLive", () => {
  it("collapses when the final answer text starts after tools", () => {
    const parts = [
      part("thought", 0, { text: "plan" }),
      part("tool_call", 1, { status: "completed", title: "Read" }),
      part("text", 2, { text: "Here is the answer." }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(false);
  });

  it("stays live when pre-tool status text exists and a tool is still running", () => {
    const parts = [
      part("thought", 0, { text: "planning" }),
      part("text", 1, { text: "Сейчас посмотрю локальные настройки." }),
      part("tool_call", 2, { status: "completed", title: "Read" }),
      part("tool_call", 3, { status: "in_progress", title: "Shell" }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(true);
    expect(finalAnswerPart(parts)).toBeNull();
  });

  it("collapses when answer streams in thought after tools even if old tools stay running", () => {
    const parts = [
      part("tool_call", 0, { status: "running", title: "Task" }),
      part("thought", 1, { text: "The resulting answer starts here." }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(false);
  });

  it("stays live while a tool is still running and no answer content exists yet", () => {
    const parts = [
      part("thought", 0, { text: "thinking" }),
      part("tool_call", 1, { status: "running", title: "Grep" }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(true);
  });

  it("collapses once all tools finish even before answer text arrives", () => {
    const parts = [
      part("thought", 0, { text: "thinking" }),
      part("tool_call", 1, { status: "completed", title: "Grep" }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(true);
    expect(stepsPartsStillLive(parts, false)).toBe(false);
  });

  it("keeps thought-only turns on the timeline until streaming stops", () => {
    const parts = [part("thought", 0, { text: "still reasoning" })];
    expect(stepsPartsStillLive(parts, true)).toBe(true);
    expect(stepsPartsStillLive(parts, false)).toBe(false);
  });
});

describe("finalAnswerPart", () => {
  it("ignores pre-tool status text when tools follow", () => {
    const parts = [
      part("text", 0, { text: "checking" }),
      part("tool_call", 1, { status: "completed", title: "Read" }),
      part("text", 2, { text: "final answer" }),
    ];
    expect(finalAnswerPart(parts)?.payload.text).toBe("final answer");
    expect(lastTextPart(parts)?.payload.text).toBe("final answer");
  });

  it("returns null when only pre-tool text exists", () => {
    const parts = [
      part("thought", 0, { text: "x" }),
      part("text", 1, { text: "status before tools" }),
      part("tool_call", 2, { status: "running", title: "Grep" }),
    ];
    expect(finalAnswerPart(parts)).toBeNull();
  });

  it("returns the last text when the turn has no tools", () => {
    const parts = [
      part("text", 0, { text: "old" }),
      part("thought", 1, { text: "x" }),
      part("text", 2, { text: "final" }),
    ];
    expect(finalAnswerPart(parts)?.payload.text).toBe("final");
  });

  it("ignores pre-tool status text while streaming", () => {
    const parts = [
      part("thought", 0, { text: "planning" }),
      part("text", 1, { text: "checking settings" }),
    ];
    expect(finalAnswerPart(parts, { streaming: true })).toBeNull();
    expect(finalAnswerPart(parts, { streaming: false })?.payload.text).toBe("checking settings");
    expect(turnAnswerVisible(parts)).toBe(false);
  });
});

describe("turnAnswerVisible", () => {
  it("is true when the final answer is present and tools are done", () => {
    const parts = [
      part("thought", 0, { text: "plan" }),
      part("tool_call", 2, { status: "completed", title: "Read" }),
      part("text", 5, { text: "Done." }),
    ];
    expect(turnAnswerVisible(parts)).toBe(true);
  });

  it("is false while a trailing tool is still active", () => {
    const parts = [
      part("tool_call", 1, { status: "in_progress", title: "Shell" }),
      part("text", 2, { text: "partial" }),
    ];
    expect(turnAnswerVisible(parts)).toBe(false);
  });

  it("is false for a long status line before tools start", () => {
    const parts = [
      part("thought", 0, { text: "planning" }),
      part("text", 1, {
        text: "Соберу коммиты за 2 и 3 сентября и сверю темы — дам осмысленную сводку, не список хешей.",
      }),
    ];
    expect(turnAnswerVisible(parts)).toBe(false);
  });

  it("is true while waiting for the first streamed part", () => {
    expect(stepsPartsStillLive([], true)).toBe(true);
    expect(stepsPartsStillLive([], false)).toBe(false);
  });
});

describe("turnStillHasLiveTools", () => {
  it("ignores buried in_progress tools when the final answer is present", () => {
    const parts = [
      part("thought", 0, { text: "plan" }),
      part("tool_call", 4, { status: "in_progress", title: "Shell" }),
      part("tool_call", 9, { status: "completed", title: "Read" }),
      part("text", 35, { text: "Done." }),
    ];
    expect(turnStillHasLiveTools(parts)).toBe(false);
  });

  it("stays live when the trailing tool is still active", () => {
    const parts = [
      part("tool_call", 0, { status: "completed", title: "Read" }),
      part("tool_call", 1, { status: "in_progress", title: "Shell" }),
    ];
    expect(turnStillHasLiveTools(parts)).toBe(true);
  });
});
