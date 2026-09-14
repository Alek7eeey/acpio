import type { MessagePartDto } from "@acpio/shared";

const ACTIVE_STEP_PART = new Set(["pending", "in_progress", "running"]);

function maxCompletedToolOrder(parts: MessagePartDto[]): number {
  let max = -1;
  for (const part of parts) {
    if (part.type !== "tool_call" && part.type !== "subagent") continue;
    const status = String(part.payload.status ?? "").toLowerCase();
    if (ACTIVE_STEP_PART.has(status)) continue;
    max = Math.max(max, part.order ?? 0);
  }
  return max;
}

function hasBlockingActiveTools(parts: MessagePartDto[]): boolean {
  const floor = maxCompletedToolOrder(parts);
  return parts.some((part) => {
    if (part.type !== "tool_call" && part.type !== "subagent") return false;
    if (!ACTIVE_STEP_PART.has(String(part.payload.status ?? "").toLowerCase())) return false;
    return (part.order ?? 0) > floor;
  });
}

function partText(part: MessagePartDto): string {
  return String(part.payload.text ?? "").trim();
}

export function lastToolOrder(parts: MessagePartDto[]): number {
  let order = -1;
  for (const part of parts) {
    if (part.type === "tool_call" || part.type === "subagent") {
      order = Math.max(order, part.order ?? 0);
    }
  }
  return order;
}

/** True when the last assistant part is still an active tool/subagent (ignores buried stale rows). */
export function turnStillHasLiveTools(parts: MessagePartDto[]): boolean {
  if (finalAnswerPart(parts, { streaming: false })) return false;

  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const lastOrder = sorted.at(-1)?.order ?? -1;
  for (const p of sorted) {
    if (p.type !== "tool_call" && p.type !== "subagent") continue;
    if (!ACTIVE_STEP_PART.has(String(p.payload.status ?? "").toLowerCase())) continue;
    if ((p.order ?? 0) >= lastOrder) return true;
  }
  return false;
}

/**
 * True when the final answer text is already on screen (post-tool only).
 * Intermediate narration followed by more thoughts/tools does not count — that
 * text must stay inside the steps block between reasoning phases.
 */
export function turnAnswerVisible(parts: MessagePartDto[]): boolean {
  if (hasBlockingActiveTools(parts)) return false;
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);
  if (toolOrder < 0) return false;
  const last = sorted.at(-1);
  if (!last || last.type !== "text") return false;
  return (last.order ?? 0) > toolOrder && partText(last).length > 0;
}

/**
 * Final answer text for the turn. When tools ran, only text emitted after the
 * last tool counts — Cursor often sends a short status line before tool calls.
 *
 * While streaming, only peel text when it is the trailing part. Otherwise
 * intermediate agent_message text between thought phases disappears from the
 * steps block (it gets promoted to the answer slot too early).
 */
export function finalAnswerPart(
  parts: MessagePartDto[],
  opts?: { streaming?: boolean },
): MessagePartDto | null {
  const streaming = opts?.streaming ?? false;
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);
  let lastTextOverall: MessagePartDto | null = null;
  let lastTextAfterTools: MessagePartDto | null = null;
  for (const part of sorted) {
    if (part.type !== "text") continue;
    lastTextOverall = part;
    if ((part.order ?? 0) > toolOrder) {
      lastTextAfterTools = part;
    }
  }
  if (toolOrder >= 0) {
    if (!streaming) return lastTextAfterTools;
    const last = sorted.at(-1);
    if (
      last?.type === "text" &&
      (last.order ?? 0) > toolOrder &&
      partText(last).length > 0
    ) {
      return last;
    }
    return null;
  }
  // Cursor may emit short status lines as text before any tool — keep them in the
  // timeline while the turn is still streaming.
  if (streaming) return null;
  return lastTextOverall;
}

/** @deprecated Prefer finalAnswerPart — kept for call sites that mean “final answer”. */
export function lastTextPart(parts: MessagePartDto[]): MessagePartDto | null {
  return finalAnswerPart(parts);
}

/** Question parts still waiting for an answer. An interactive prompt belongs
 *  outside the steps spoiler: buried in the transcript it reads as one more
 *  tool row, while the live header next to it still claims the agent is
 *  working — yet nothing streams again until the user answers. */
export function unansweredQuestionParts(parts: MessagePartDto[]): MessagePartDto[] {
  return parts.filter((p) => p.type === "question" && Boolean(p.payload.pending));
}

/** True while the phased timeline should stay up (tools running, pre-answer reasoning). */
export function stepsPartsStillLive(parts: MessagePartDto[], streaming: boolean): boolean {
  if (!streaming) return false;
  if (unansweredQuestionParts(parts).length > 0) return false;
  if (parts.length === 0) return true;

  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);

  const finalText = finalAnswerPart(parts, { streaming });
  if (finalText && partText(finalText).length > 0) {
    return false;
  }

  if (
    toolOrder >= 0 &&
    sorted.some(
      (p) =>
        (p.order ?? 0) > toolOrder &&
        p.type === "thought" &&
        partText(p).length > 0,
    )
  ) {
    return false;
  }

  if (turnStillHasLiveTools(parts)) {
    return true;
  }

  if (toolOrder < 0) {
    const last = sorted[sorted.length - 1];
    return last?.type === "thought" || last?.type === "text";
  }

  // Tools finished but the post-tool answer has not started yet — keep the timeline.
  return true;
}

/**
 * One contiguous stretch of agent activity — thoughts and tool calls in
 * emission order.
 *
 * A thought that lands after a tool has already completed must NOT open a new
 * run: harnesses stream `tool_call → thought → tool_call`, and splitting on
 * that shattered a single real omp turn into three phases, the first of them
 * with no thoughts at all (see the captured transcript in the timeline work).
 * Runs close on visible text or on a question, nothing else: a part that
 * renders nothing (plan, status, empty text) is transparent to the run.
 */
export type AgentTimelineItem =
  | { kind: "run"; parts: MessagePartDto[] }
  | { kind: "text"; part: MessagePartDto; key: string }
  | { kind: "question"; part: MessagePartDto; key: string };

/**
 * Group a turn's non-answer parts into `run → text → run → text …`, in emission
 * order, for both display states: while the agent still generates this is what
 * the reader sees inline; once it stops, the same items become the body of the
 * single collapsed spoiler.
 *
 * Questions stay top-level items so an interactive prompt never ends up buried
 * inside a spoiler. Parts without visible content (empty thoughts, plans,
 * statuses) are dropped, matching what the flat steps body renders — and they
 * do not close the run either. Closing on them stacked two "Работал" headers
 * with nothing between them, which is what omp's per-todo `plan` updates did
 * to nearly every long turn.
 */
export function buildAgentTimeline(parts: MessagePartDto[]): AgentTimelineItem[] {
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const items: AgentTimelineItem[] = [];
  let runBuf: MessagePartDto[] = [];

  const flushRun = () => {
    if (runBuf.length === 0) return;
    items.push({ kind: "run", parts: runBuf });
    runBuf = [];
  };

  for (const part of sorted) {
    if (part.type === "thought") {
      if (!partText(part)) continue;
      runBuf.push(part);
      continue;
    }
    if (part.type === "tool_call" || part.type === "subagent") {
      runBuf.push(part);
      continue;
    }
    if (part.type === "question") {
      flushRun();
      items.push({ kind: "question", part, key: part.id });
      continue;
    }
    if (part.type === "text" && partText(part)) {
      flushRun();
      items.push({ kind: "text", part, key: part.id });
    }
  }
  flushRun();
  return items;
}
