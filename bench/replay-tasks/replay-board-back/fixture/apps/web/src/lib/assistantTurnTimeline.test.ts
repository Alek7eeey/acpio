import { describe, expect, it } from "vitest";
import type { MessagePartDto } from "@acpio/shared";
import { buildAgentTimeline, finalAnswerPart, isSingleItemTimeline, lastTextPart, stepsPartsStillLive, turnAnswerVisible, turnStillHasLiveTools, unansweredQuestionParts } from "./assistantTurnTimeline.js";

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

  // A parked question used to be counted as "tools finished, answer pending",
  // so the spoiler header kept pulsing "Working…" while the agent waited.
  it("goes quiet on a pending question even after finished tools", () => {
    const parts = [
      part("thought", 0, { text: "checking the config" }),
      part("tool_call", 1, { status: "completed", title: "Read" }),
      part("question", 2, { requestId: "q1", pending: true }),
    ];
    expect(stepsPartsStillLive(parts, true)).toBe(false);
  });

  it("counts only unanswered questions as parked", () => {
    const answered = [
      part("tool_call", 0, { status: "completed", title: "Read" }),
      part("question", 1, { requestId: "q1", pending: false }),
    ];
    expect(unansweredQuestionParts(answered)).toEqual([]);
    expect(stepsPartsStillLive(answered, true)).toBe(true);

    const pending = part("question", 1, { requestId: "q2", pending: true });
    expect(unansweredQuestionParts([pending, ...answered])).toEqual([pending]);
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

  it("peels trailing text before the first tool while streaming", () => {
    const parts = [
      part("thought", 0, { text: "planning" }),
      part("text", 1, { text: "checking settings" }),
    ];
    // The trailing text is the answer being written: it must render in the
    // answer's own style from the first token, not turn white when the turn ends.
    expect(finalAnswerPart(parts, { streaming: true })?.payload.text).toBe("checking settings");
    expect(finalAnswerPart(parts, { streaming: false })?.payload.text).toBe("checking settings");
    expect(turnAnswerVisible(parts)).toBe(false);
  });

  it("demotes pre-tool text back into the steps block once a thought follows", () => {
    const parts = [
      part("text", 0, { text: "checking settings" }),
      part("thought", 1, { text: "revising" }),
    ];
    expect(finalAnswerPart(parts, { streaming: true })).toBeNull();
    expect(finalAnswerPart(parts, { streaming: false })?.payload.text).toBe("checking settings");
  });

  it("keeps intermediate post-tool text in steps when more thoughts follow", () => {
    const parts = [
      part("thought", 0, { text: "plan" }),
      part("tool_call", 1, { status: "completed", title: "Read" }),
      part("text", 2, { text: "Сначала сверю локальные настройки." }),
      part("thought", 3, { text: "next phase" }),
    ];
    expect(finalAnswerPart(parts, { streaming: true })).toBeNull();
    expect(turnAnswerVisible(parts)).toBe(false);
  });

  it("peels trailing post-tool text while streaming", () => {
    const parts = [
      part("thought", 0, { text: "plan" }),
      part("tool_call", 1, { status: "completed", title: "Read" }),
      part("text", 2, { text: "Here is the answer." }),
    ];
    expect(finalAnswerPart(parts, { streaming: true })?.payload.text).toBe("Here is the answer.");
    expect(turnAnswerVisible(parts)).toBe(true);
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

  it("is false when narration text is followed by another reasoning phase", () => {
    const parts = [
      part("tool_call", 0, { status: "completed", title: "Read" }),
      part("text", 1, { text: "Промежуточная мысль текстом." }),
      part("thought", 2, { text: "дальше думаю" }),
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

describe("buildAgentTimeline", () => {
  const shape = (parts: MessagePartDto[]) =>
    buildAgentTimeline(parts).map((item) => (item.kind === "run" ? `run(${item.parts.length})` : item.kind));

  // A real omp turn streams `tool_call → thought → tool_call → thought`: the
  // thought lands after the previous tool already completed and must stay in
  // the same run. Splitting on it turned one continuous stretch of work into
  // three phases, the first of them with no thoughts at all.
  it("keeps thoughts and tool calls in one run whatever their emission order", () => {
    const parts = [
      part("tool_call", 0, { title: "Read a.ts", status: "completed" }),
      part("thought", 1, { text: "Need the bodies." }),
      part("tool_call", 2, { title: "Read a.ts:1-200", status: "completed" }),
      part("thought", 3, { text: "Now I can answer." }),
    ];
    expect(shape(parts)).toEqual(["run(4)"]);
  });

  it("closes a run on visible text and opens the next one after it", () => {
    const parts = [
      part("text", 0, { text: "I'll read both files." }),
      part("tool_call", 1, { title: "Read a.ts", status: "completed" }),
      part("tool_call", 2, { title: "Read b.ts", status: "completed" }),
      part("thought", 3, { text: "Both are utilities." }),
      part("tool_call", 4, { title: "Read a.ts:raw", status: "completed" }),
      part("thought", 5, { text: "Writing the summary." }),
      part("text", 6, { text: "Step 1 — …" }),
    ];
    expect(shape(parts)).toEqual(["text", "run(5)", "text"]);
  });

  it("drops empty thoughts instead of opening a run for them", () => {
    const parts = [
      part("thought", 0, { text: "   " }),
      part("tool_call", 1, { title: "Read a.ts", status: "completed" }),
    ];
    expect(shape(parts)).toEqual(["run(1)"]);
  });

  // omp sends a `plan` update on every todo change, and the body renders plan
  // parts as nothing — closing a run on them left two "Работал" headers with
  // an empty gap between them (turn a788b7a9: tools → plan → tools).
  it("keeps one run across parts that render nothing", () => {
    const parts = [
      part("tool_call", 0, { title: "Read a.ts", status: "completed" }),
      part("plan", 1, { entries: [{ content: "step", status: "completed" }] }),
      part("thought", 2, { text: "" }),
      part("permission", 3, { requestId: "p1", pending: true }),
      part("status", 4, { kind: "image" }),
      part("tool_call", 5, { title: "Read b.ts", status: "completed" }),
    ];
    expect(shape(parts)).toEqual(["run(2)"]);
  });

  it("keeps questions out of runs so an interactive prompt is never buried", () => {
    const parts = [
      part("tool_call", 0, { title: "Read a.ts", status: "completed" }),
      part("question", 1, { requestId: "q1", pending: true }),
      part("tool_call", 2, { title: "Read a.ts:raw", status: "completed" }),
    ];
    expect(shape(parts)).toEqual(["run(1)", "question", "run(1)"]);
  });
});

describe("isSingleItemTimeline", () => {
  // The finished turn folds everything but the answer into one outer "Работал"
  // spoiler. When its transcript is a single run, that header only nests a
  // second identical spoiler — the caller must drop the outer one.
  it("flags a timeline of one run", () => {
    const items = buildAgentTimeline([
      part("thought", 0, { text: "Plan." }),
      part("tool_call", 1, { title: "Read a.ts", status: "completed" }),
    ]);
    expect(items).toHaveLength(1);
    expect(isSingleItemTimeline(items)).toBe(true);
  });

  it("flags a lone intermediate text or question", () => {
    expect(isSingleItemTimeline(buildAgentTimeline([part("text", 0, { text: "hi" })]))).toBe(true);
    expect(
      isSingleItemTimeline(buildAgentTimeline([part("question", 0, { requestId: "q1" })])),
    ).toBe(true);
  });

  it("keeps the outer header once a second item appears", () => {
    const items = buildAgentTimeline([
      part("tool_call", 0, { title: "Read a.ts", status: "completed" }),
      part("text", 1, { text: "Interim narration." }),
      part("tool_call", 2, { title: "Read b.ts", status: "completed" }),
    ]);
    expect(isSingleItemTimeline(items)).toBe(false);
  });

  it("does not flag an empty timeline or a contentless live run", () => {
    expect(isSingleItemTimeline([])).toBe(false);
    expect(isSingleItemTimeline([{ kind: "run", parts: [] }])).toBe(false);
  });
});
