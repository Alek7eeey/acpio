import { isProtocolPlaceholder, type MessagePartDto } from "@acpio/shared";

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

/** Visible message text: harness filler for messages the model left empty
 *  renders as nothing. Sessions recorded before the server started dropping
 *  the filler still hold it as a text part, so display-side filtering is
 *  needed regardless. */
function visibleText(part: MessagePartDto): string {
  if (part.type !== "text") return "";
  const text = partText(part);
  return isProtocolPlaceholder(text) ? "" : text;
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
  return (last.order ?? 0) > toolOrder && visibleText(last).length > 0;
}

/**
 * Final answer text for the turn. When tools ran, only text emitted after the
 * last tool counts — Cursor often sends a short status line before tool calls.
 *
 * While streaming, only peel text when it is the trailing part. Otherwise
 * intermediate agent_message text between thought phases disappears from the
 * steps block (it gets promoted to the answer slot too early). The same holds
 * before the first tool of the turn: the trailing text is the answer being
 * written, so it is peeled out and rendered as the answer right away.
 */
export function finalAnswerPart(
  parts: MessagePartDto[],
  opts?: { streaming?: boolean },
): MessagePartDto | null {
  const streaming = opts?.streaming ?? false;
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);
  // A pending question owns the text right before it: there is no answer until
  // the user replies, so that lead-in must not be promoted to the answer slot,
  // where it would render loose above the prompt it introduces.
  const claimed = new Set<string>();
  for (const list of splitQuestionPreamble(sorted).values()) {
    for (const p of list) claimed.add(p.id);
  }
  let lastTextOverall: MessagePartDto | null = null;
  let lastTextAfterTools: MessagePartDto | null = null;
  for (const part of sorted) {
    if (part.type !== "text" || !visibleText(part) || claimed.has(part.id)) continue;
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
      visibleText(last).length > 0 &&
      !claimed.has(last.id)
    ) {
      return last;
    }
    return null;
  }
  // No tool has run yet: while streaming, the trailing text is the answer so
  // far. Peeling it out immediately is what makes it render in the answer's own
  // style from the first token — inside the steps block the very same text is
  // the dimmed "intermediate narration" style, so it used to turn from grey to
  // white (and from 0.86rem to 0.96rem) the moment the turn ended. A thought or
  // tool arriving next demotes it back into the steps block, exactly like text
  // between two tool calls.
  if (streaming) {
    const last = sorted.at(-1);
    return last?.type === "text" && partText(last).length > 0 ? last : null;
  }
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
    const renderable = sorted.filter((p) => p.type !== "text" || visibleText(p).length > 0);
    const last = renderable[renderable.length - 1];
    return last?.type === "thought" || last?.type === "text";
  }

  // Tools finished but the post-tool answer has not started yet — keep the timeline.
  return true;
}

/** A prompt joined to the lead-in text that introduced it. */
export type AgentQuestionItem = {
  kind: "question";
  part: MessagePartDto;
  /** Lead-in text emitted right before the prompt, rendered joined to it —
   *  see `splitQuestionPreamble`. Empty for a bare question. */
  preamble: MessagePartDto[];
  key: string;
};

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
  | AgentQuestionItem;

/**
 * Find, for every parked question, the lead-in text it owns.
 *
 * The model narrates ("I need to know X first") and then asks, so the text
 * emitted immediately before a prompt belongs to that prompt. It is not the
 * turn's answer — there is no answer until the user replies — so promoting it
 * to the answer slot rendered it loose above the prompt it introduces, under a
 * closed "Работал" header that claimed the turn was over while the agent was
 * still parked. Thoughts and tool rows are not a lead-in: they are the work
 * that produced the question and keep their own block above it.
 *
 * Scoped to one assistant message (a turn boundary: the server opens a fresh
 * assistant message per turn) and to the contiguous run of text just before the
 * prompt, so narration from earlier in the turn is left where it was emitted.
 */
export function splitQuestionPreamble(parts: MessagePartDto[]): Map<string, MessagePartDto[]> {
  const result = new Map<string, MessagePartDto[]>();
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const part = sorted[i];
    if (!part || part.type !== "question" || !part.payload.pending) continue;
    const preamble: MessagePartDto[] = [];
    // Only the text the model wrote immediately before asking — its own lead-in
    // ("I need to check X before I can answer") — and only within this turn's
    // assistant message. Thoughts and tool rows are the work that produced the
    // question, not its preamble: they keep their own timeline block above the
    // prompt, with their own measured span. An earlier question in the same
    // message ends the search: everything above it is a transcript of its own.
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = sorted[j];
      if (!prev) break;
      if (prev.messageId !== part.messageId) break;
      if (prev.type === "text") {
        if (!visibleText(prev)) continue;
        preamble.unshift(prev);
        continue;
      }
      // Only whitespace, error rows, other questions and the question's own ask
      // row are transparent to the walk; anything else (thought, tool,
      // subagent) ends the lead-in.
      if (prev.type === "question" || prev.type === "error") break;
      if (prev.type === "status" || prev.type === "plan" || prev.type === "permission") continue;
      // This harness records the ask call BETWEEN the lead-in and the prompt it
      // introduces (`text → ask → question`): the request leaves the tool body
      // directly while the row waits behind the streamed-text backlog. The call
      // is the question's own work, so it neither ends the lead-in nor keeps the
      // text out of the prompt's bucket — stopping here left the narration loose
      // and dimmed in the timeline with the call's own "Работал" block over the
      // card, while the agent was already parked on the reader.
      if (isAskToolCallRow(part, prev)) continue;
      break;
    }
    result.set(part.id, preamble);
  }
  return result;
}

/** Questions an ask tool call carries in its recorded rawInput — the harness
 *  schema shape (`question`/`header`/`multi`), not the UI payload shape. */
function askToolCallQuestions(part: MessagePartDto): Array<Record<string, unknown>> | null {
  if (part.type !== "tool_call" && part.type !== "subagent") return null;
  const raw = part.payload.raw as { rawInput?: { questions?: unknown } } | undefined;
  const input = (raw?.rawInput ?? part.payload.rawInput) as { questions?: unknown } | undefined;
  const questions = input?.questions;
  return Array.isArray(questions) && questions.length > 0
    ? (questions as Array<Record<string, unknown>>)
    : null;
}

/** Content fingerprint of a question list. The question part stores the UI
 *  conversion of what the call recorded in rawInput, so byte equality never
 *  matches (`prompt` vs `question`, options gain `id`); prompt text and option
 *  labels do — they are the same strings in both shapes. */
function questionFingerprint(questions: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    questions.map((q) => [
      String(q.prompt ?? q.question ?? ""),
      (Array.isArray(q.options) ? q.options : []).map((o) =>
        String((o as Record<string, unknown>).label ?? ""),
      ),
    ]),
  );
}

/** True when the candidate part is the tool call that asked this question.
 *  The harness delivers the ask call's tool_call row after the elicitation it
 *  triggers — the request leaves the tool body directly while the row waits
 *  behind the streamed-text backlog — so the recorded order puts the question
 *  above its own call (80 of 83 recorded dialogs: the call is the very next
 *  part with matching questions). */
export function isAskToolCallRow(question: MessagePartDto, candidate: MessagePartDto): boolean {
  if (candidate.messageId !== question.messageId) return false;
  const asked = question.payload.questions;
  if (!Array.isArray(asked) || asked.length === 0) return false;
  const raw = askToolCallQuestions(candidate);
  if (!raw) return false;
  return questionFingerprint(raw) === questionFingerprint(asked as Array<Record<string, unknown>>);
}

/**
 * Group a turn's non-answer parts into `run → text → run → text …`, in emission
 * order, for both display states: while the agent still generates this is what
 * the reader sees inline; once it stops, the same items become the body of the
 * single collapsed spoiler.
 *
 * Questions stay top-level items so an interactive prompt never ends up buried
 * inside a spoiler, and they absorb their own lead-in text (see
 * `splitQuestionPreamble`) so the prompt renders with — not under — the
 * sentence that introduced it. Work that produced the question (thoughts, tool
 * rows) keeps its own block above the prompt. Parts without visible content
 * (empty thoughts, plans, statuses) are dropped, matching what the flat steps
 * body renders — and they do not close the run either. Closing on them stacked
 * two "Работал" headers with nothing between them, which is what omp's per-todo
 * `plan` updates did to nearly every long turn.
 *
 * An ask dialog's own tool call is that work too, even though the harness
 * delivered it after the question (see `isAskToolCallRow`): it rides up into
 * the run above the card instead of opening a new "Работаю…" block under it.
 */
export function buildAgentTimeline(parts: MessagePartDto[]): AgentTimelineItem[] {
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const preambles = splitQuestionPreamble(sorted);
  const attachedIds = new Set<string>();
  for (const list of preambles.values()) for (const p of list) attachedIds.add(p.id);
  const items: AgentTimelineItem[] = [];
  const consumed = new Set<string>();
  let runBuf: MessagePartDto[] = [];

  const flushRun = () => {
    if (runBuf.length === 0) return;
    items.push({ kind: "run", parts: runBuf });
    runBuf = [];
  };

  for (let i = 0; i < sorted.length; i += 1) {
    const part = sorted[i]!;
    // A part the question absorbed renders inside that question's bucket, never
    // on its own — the run it would have opened above the prompt is gone.
    if (attachedIds.has(part.id)) continue;
    if (consumed.has(part.id)) continue;
    if (part.type === "question") {
      // The ask call following the question renders with the work above it:
      // pull it into the current run (or a fresh one) before the card closes.
      const call = i + 1 < sorted.length ? sorted[i + 1] : undefined;
      if (call && isAskToolCallRow(part, call)) {
        runBuf.push(call);
        consumed.add(call.id);
      }
      flushRun();
      items.push({ kind: "question", part, preamble: preambles.get(part.id) ?? [], key: part.id });
      continue;
    }
    if (part.type === "thought") {
      if (!partText(part)) continue;
      runBuf.push(part);
      continue;
    }
    if (part.type === "tool_call" || part.type === "subagent") {
      runBuf.push(part);
      continue;
    }
    if (part.type === "text" && visibleText(part)) {
      flushRun();
      items.push({ kind: "text", part, key: part.id });
    }
  }
  flushRun();
  return items;
}

/** True when the whole timeline is one item — a single run, or a lone
 *  text/question. The finished turn wraps its phased items in an outer
 *  "Работал" spoiler; over one item that header only nests a second spoiler
 *  (or hides nothing), so the caller can drop it and show the item directly.
 *  A run with no parts (the empty live block) still needs the header — there
 *  would be nothing to show without it. A question with a preamble is two
 *  things joined on screen (the text, then the prompt), so folding the header
 *  away would drop the transcript above its own question. */
export function isSingleItemTimeline(items: AgentTimelineItem[]): boolean {
  const only = items.length === 1 ? items[0] : undefined;
  if (!only) return false;
  if (only.kind === "run" && only.parts.length === 0) return false;
  if (only.kind === "question" && only.preamble.length > 0) return false;
  return true;
}
