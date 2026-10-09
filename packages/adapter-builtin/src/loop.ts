import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";

/** Model instance accepted by `streamText` — derived, never re-declared. */
export type TurnModel = Parameters<typeof streamText>[0]["model"];

export type TurnStopReason = "end_turn" | "stop_sequence" | "max_tokens" | "refusal";

export interface TurnOptions {
  model: TurnModel;
  system: string;
  /** Already pruned for the context window — see {@link pruneMessages}. */
  messages: ModelMessage[];
  tools: ToolSet;
  abortSignal: AbortSignal;
  /** One ACP `session/update` payload, session-scoped by the caller. */
  emit: (update: Record<string, unknown>) => void;
  /** Context window of the active model, for the usage chip. */
  contextWindow: number;
  /** Step ceiling for this turn, for the caller's wrap-up flow — see
   * {@link runTurn}'s `stepBudgetHit`. Defaults to {@link MAX_TOOL_STEPS}. */
  maxSteps?: number;
  /** Cap on one step's answer, tokens. 0 = the provider default; unset =
   * {@link MAX_OUTPUT_TOKENS}. */
  maxOutputTokens?: number;
  /**
   * Per-step cap on private reasoning, characters (0/unset = off). Crossing
   * it aborts the model call mid-think: the reasoning already streamed rides
   * into the history as the step's partial thinking, and the caller's
   * continuation carries the turn on with a reminder. The fuse stands down
   * once the step starts acting — a half-streamed tool call or answer is
   * never torn apart by a thinking cap.
   */
  reasoningLimitChars?: number;
  /**
   * Drain messages the host asked for mid-turn (`session/steer`). The loop
   * calls it before every model call and folds whatever comes back into that
   * call — acking each once it really joined a prompt.
   */
  takeSteer?: () => Array<{ message: ModelMessage; ack: () => void }>;
  /**
   * How often to tick `session/update: heartbeat` while a tool runs — the
   * host's idle ceiling counts silence, so a tool quiet for minutes must
   * still prove the agent is alive. Unset = {@link HEARTBEAT_MS}; tests
   * shrink it.
   */
  heartbeatMs?: number;
}

export interface TurnOutcome {
  /** Messages this turn produced — append them to the stored history. */
  response: ModelMessage[];
  stopReason: TurnStopReason;
  /** Model-call failure: output is already produced and must be persisted. */
  failure?: Error;
  /**
   * The turn's step was cut off before it answered: the model stopped on
   * reasoning alone, or the harness's own output cap cut it mid-answer. The
   * chain is broken, not finished — the caller continues it instead of ending
   * the turn on a step the user cannot act on.
   */
  truncated?: boolean;
  /** The turn ended on the caller's step ceiling, not the model stopping —
   * the work is still in flight. See {@link WRAP_UP_STEPS}. */
  stepBudgetHit?: boolean;
  /** The step's reasoning crossed {@link TurnOptions.reasoningLimitChars}:
   * the model call was cut mid-think and `response` ends with the partial
   * reasoning. Not an answer — the caller continues the turn with a reminder
   * instead of ending it on a step the model never acted on. */
  reasoningLimitHit?: boolean;
  /** Mid-turn messages folded into the stream, each with the history index it
   * belongs at — splice them into `response` to keep a truthful transcript. */
  injected?: Array<{ at: number; message: ModelMessage }>;
}

/**
 * Keep only the newest messages that fit. Whole user-turn groups are dropped so
 * history never starts mid-tool-call — the SDK rejects a tool message whose
 * assistant call is missing, and a model misreads a truncated thread.
 * Estimation is chars/4 with a 20% safety margin: rough but one-directional.
 * `thresholdPercent` is where the caller wants the view to land — 80 by default,
 * the same line the compaction trigger uses.
 */
export function pruneMessages(
  messages: ModelMessage[],
  contextWindow: number,
  thresholdPercent = 80,
): ModelMessage[] {
  if (!(contextWindow > 0)) return messages;
  const budget = contextWindow * (thresholdPercent / 100);
  if (estimateTokens(messages) <= budget) return messages;

  const cuts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "user") cuts.push(i);
  }
  // Newest-first would always land on the smallest slice; walk oldest cut
  // first so the largest window that still fits is the one kept.
  for (let c = 0; c < cuts.length; c++) {
    const slice = messages.slice(cuts[c]);
    if (estimateTokens(slice) <= budget) return slice;
  }
  return cuts.length ? messages.slice(cuts[cuts.length - 1]) : messages;
}

/** chars/4 is a deliberate overestimate of the token count — see {@link pruneMessages}. */
/**
 * Flat cost of one attachment, image or not. A provider bills an image by its
 * pixels — a screenshot is a couple of thousand tokens — while its base64 is
 * megabyte-sized: counting the base64 fires the pass on a history that fits and
 * makes the compaction row report a window the model never had.
 */
const IMAGE_TOKEN_ESTIMATE = 1_500;

/** A part carrying image bytes, in either shape the SDK sends them. */
function carriesImage(part: unknown): boolean {
  const candidate = part as { type?: unknown; mediaType?: unknown } | null;
  if (!candidate) return false;
  if (candidate.type === "image") return true;
  return candidate.type === "file" && String(candidate.mediaType ?? "").startsWith("image/");
}

export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message).length;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (carriesImage(part)) chars -= JSON.stringify(part).length - IMAGE_TOKEN_ESTIMATE * 4;
    }
  }
  return Math.ceil(chars / 4);
}

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return "";
  const row = part as Record<string, unknown>;
  switch (row.type) {
    case "text":
      return typeof row.text === "string" ? row.text : "";
    case "reasoning":
      return typeof row.text === "string" ? `(thinking) ${row.text}` : "";
    case "tool-call":
      return `(call ${String(row.toolName ?? "")}) ${JSON.stringify(row.input ?? {})}`;
    case "tool-result":
      return `(result ${String(row.toolName ?? "")}) ${JSON.stringify(row.output ?? "")}`;
    case "image":
    case "file":
      return "[attachment]";
    default:
      return "";
  }
}

function messageText(message: ModelMessage): string {
  if (!("content" in message)) return "";
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(partText).filter(Boolean).join("\n");
}

/** Flatten stored messages into text a summary prompt can read. */
export function renderTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (text) lines.push(`${message.role}: ${text}`);
  }
  return lines.join("\n\n");
}

const COMPACT_MARKER = "[Compacted earlier conversation — summary of the turns dropped to fit the context window]";

/** Tools whose output the model can simply produce again — a re-readable result. */
const RE_READABLE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

/** What a masked result leaves behind: a note, not content the model may trust. */
export const MASKED_RESULT_NOTE = "[output dropped to free room — call the tool again if you need it]";

/** How much of the model's own reasoning the view keeps. */
export type ReasoningPolicy = "keep" | "before-last-message" | "drop";

/**
 * True when the history carries any assistant reasoning. A thinking model reads
 * its own traces, so masking its observations costs it accuracy — the caller
 * checks this before pruning them (arXiv 2508.21433).
 */
export function hasReasoning(messages: ModelMessage[]): boolean {
  return messages.some(
    (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "reasoning"),
  );
}

/**
 * Two independent squeezes of an already-built prompt view, both free — no
 * model call:
 *
 * - Tool results older than the newest `keepLast` messages lose their bytes if
 *   the tool can be called again (`read`, `grep`, `glob`). The call that
 *   produced them stays, so the model can re-run it.
 * - Reasoning parts follow `policy`: `keep` leaves them, `before-last-message`
 *   keeps only the newest answer's, `drop` clears them all.
 *
 * Deterministic in the message alone: the same view masks to the same bytes on
 * every turn, so a cached prompt prefix survives.
 */
export function maskToolResults(
  messages: ModelMessage[],
  keepLast: number,
  policy: ReasoningPolicy = "keep",
): ModelMessage[] {
  const boundary = Math.max(0, messages.length - Math.max(0, keepLast));
  const lastIndex = messages.length - 1;
  let changed = false;
  const out: ModelMessage[] = messages.map((message, index): ModelMessage => {
    let content = Array.isArray(message.content) ? message.content : undefined;

    if (message.role === "tool" && index < boundary && content) {
      let touched = false;
      const masked = content.map((part) => {
        if (part.type !== "tool-result" || !RE_READABLE_TOOLS[part.toolName]) return part;
        const current = part.output as { value?: unknown } | undefined;
        if (current?.value === MASKED_RESULT_NOTE) return part;
        touched = true;
        return { ...part, output: { type: "text" as const, value: MASKED_RESULT_NOTE } };
      });
      if (touched) {
        changed = true;
        return { ...message, content: masked } as ModelMessage;
      }
    }

    const dropReasoning =
      message.role === "assistant" &&
      content?.some((part) => part.type === "reasoning") &&
      (policy === "drop" || (policy === "before-last-message" && index < lastIndex));
    if (dropReasoning && content) {
      changed = true;
      return { ...message, content: content.filter((part) => part.type !== "reasoning") } as ModelMessage;
    }

    return message;
  });
  return changed ? out : messages;
}

/** Digest of an already-covered prefix of the stored history — outlives a turn. */
export interface CompactionState {
  /** The summary the previous pass wrote for `messages[0..covered)`. */
  summary: string;
  /** Stored-message count the digest stands in for. */
  covered: number;
}

/**
 * The digest as the model receives it: one user message carrying the summary.
 * Exported because the summariser rebuilds the same bytes: a rolling pass
 * re-sends the previous digest as the head of its own request, so that request
 * stays a prefix of the one the previous turn already sent (and paid for).
 */
export function digestMessage(summary: string): ModelMessage {
  return { role: "user", content: `${COMPACT_MARKER}\n\n${summary.trim()}` };
}

/**
 * The view the model actually gets: the digest standing in for the covered
 * prefix, then the verbatim tail. The covered prefix is spoken for — storage
 * promises it is never sent verbatim again — so every size judgement (the
 * trigger line, the reported "before") is made here. Reading the raw
 * transcript instead would count bytes no request carries: a session with a
 * bulky folded prefix looks over the line forever, and the row reports a
 * window the model never had.
 */
export function promptView(messages: ModelMessage[], state?: CompactionState): ModelMessage[] {
  if (!state || !(state.covered > 0)) return messages;
  return [digestMessage(state.summary), ...messages.slice(state.covered)];
}

export interface CompactOptions {
  messages: ModelMessage[];
  contextWindow: number;
  /** Summarises the turns that no longer fit; may throw. */
  summarize: (dropped: ModelMessage[]) => Promise<string>;
}

export interface CompactHistoryOptions {
  messages: ModelMessage[];
  contextWindow: number;
  /** Fire the pass once the view passes this percent of the window. */
  thresholdPercent: number;
  /**
   * Line the produced view must sit under. A digest that leaves the view above
   * it is a retelling, not a condensation, and pruning is strictly better.
   * Defaults to `thresholdPercent` — the pass is then judged against the line
   * that fired it.
   */
  fitPercent?: number;
  /** Percent of the window kept verbatim at the newest end. */
  keepRecentPercent?: number;
  /** Digest of the prefix covered by an earlier pass, if any. */
  state?: CompactionState;
  /** First-time digest of the dropped turns. */
  summarize: (dropped: ModelMessage[]) => Promise<string>;
  /**
   * Rolling digest: the turns covered by `previous` plus the newly dropped
   * delta. Without it a second pass re-summarises the whole head.
   */
  update?: (delta: ModelMessage[], previous: string) => Promise<string>;
}

/** Weight of the verbatim tail when the caller does not name one. */
const DEFAULT_KEEP_RECENT_PERCENT = 60;

/**
 * Prefer a summary over amnesia: past `thresholdPercent` of the window the
 * oldest turns are replaced by one model-written digest, keeping
 * `keepRecentPercent` of the window verbatim at the newest end. Storage is
 * untouched — the caller keeps the full history and only this turn's view is
 * compacted. A rolling `state`/`update` pair digests only the new delta.
 *
 * Any failure — the summariser throws, comes back empty, or hands back a
 * digest that leaves the view above the fit line — falls back to
 * {@link pruneMessages}, so a broken summariser never breaks a chat.
 */
export async function compactHistory(
  opts: CompactHistoryOptions,
): Promise<{ messages: ModelMessage[]; state?: CompactionState }> {
  const { messages, contextWindow, state } = opts;
  const line = contextWindow * (opts.thresholdPercent / 100);
  const keepState = state ? { state } : {};
  // The line is read on the view the pass would leave behind: the digest
  // already stands in for the covered prefix, which no request sees again.
  const entered = promptView(messages, state);
  if (!(contextWindow > 0) || estimateTokens(entered) <= line) {
    return { messages: entered, ...keepState };
  }

  const covered = state?.covered ?? 0;
  const tailBudget = contextWindow * ((opts.keepRecentPercent ?? DEFAULT_KEEP_RECENT_PERCENT) / 100);
  // Newest-first turn boundary that leaves a tail no bigger than the budget.
  // Never cut inside the already-covered prefix: its messages are spoken for.
  let cut = 0;
  for (let i = Math.max(1, covered); i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    if (estimateTokens(messages.slice(i)) <= tailBudget) {
      cut = i;
      break;
    }
  }
  const pruneFallback = (): ModelMessage[] => {
    // The digest a previous pass paid for is worth keeping: prune the verbatim
    // tail under it instead of sending the covered prefix back whole.
    if (state) {
      return [
        digestMessage(state.summary),
        ...pruneMessages(messages.slice(state.covered), contextWindow, opts.thresholdPercent),
      ];
    }
    return pruneMessages(messages, contextWindow, opts.thresholdPercent);
  };
  if (cut <= covered) return { messages: pruneFallback(), ...keepState };

  try {
    const summary =
      state && opts.update
        ? await opts.update(messages.slice(covered, cut), state.summary)
        : await opts.summarize(messages.slice(0, cut));
    const trimmed = summary.trim();
    if (!trimmed) return { messages: pruneFallback(), ...keepState };
    const view: ModelMessage[] = [digestMessage(trimmed), ...messages.slice(cut)];
    const fit = contextWindow * ((opts.fitPercent ?? opts.thresholdPercent) / 100);
    // A view above the fit line re-reads nearly everything anyway while still
    // destroying the cached prefix (observed on the 2026-10-05 long run: two
    // compactions bought 25149 -> 24235 wire tokens each): the summariser
    // retold instead of condensed, and pruning keeps more verbatim for the
    // same size.
    if (estimateTokens(view) > fit) return { messages: pruneFallback(), ...keepState };
    return { messages: view, state: { summary: trimmed, covered: cut } };
  } catch {
    return { messages: pruneFallback(), ...keepState };
  }
}

/**
 * The plain form: one pass at the default line, no state carried between
 * turns. {@link compactHistory} is the shape the agent uses.
 */
export async function compactMessages(opts: CompactOptions): Promise<ModelMessage[]> {
  const { messages, contextWindow, summarize } = opts;
  const result = await compactHistory({
    messages,
    contextWindow,
    thresholdPercent: 80,
    summarize,
  });
  return result.messages;
}

function toolTitle(toolName: string, input: Record<string, unknown>): string {
  const subject =
    typeof input.path === "string"
      ? input.path
      : typeof input.command === "string"
        ? input.command
        : "";
  const oneLine = subject.replace(/\s+/g, " ").trim();
  if (!oneLine) return toolName;
  return `${toolName} ${oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine}`;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * The streamed `error` part is the only carrier of the real cause: when no
 * step completed, the SDK rejects every result promise with its generic
 * "No output generated" error. Shape a message the user can act on — provider
 * text, HTTP status, endpoint and a response-body excerpt, since a bad header
 * or key often shows only in one of them. Retried calls hand us a RetryError
 * whose `errors` array holds the actual provider error.
 */
function describeStreamError(value: unknown): Error {
  const error = toError(value);
  const source = value as {
    statusCode?: unknown;
    url?: unknown;
    responseBody?: unknown;
    errors?: unknown[];
  };
  const detail = (source.errors?.length
    ? source.errors[source.errors.length - 1]
    : value) as typeof source;

  const status = Number(detail?.statusCode);
  const url = typeof detail?.url === "string" ? detail.url : "";
  const body = typeof detail?.responseBody === "string" ? detail.responseBody.trim() : "";

  const head: string[] = [];
  if (Number.isFinite(status) && status > 0) head.push(`HTTP ${status}`);
  if (url) head.push(url);
  const prefix = head.length
    ? `Модель ответила ошибкой (${head.join(", ")})`
    : "Модель ответила ошибкой";
  let message = `${prefix}: ${error.message || "без описания"}`;
  if (body && !message.includes(body)) {
    message += `\nОтвет сервера: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}`;
  }
  return new Error(message, { cause: error });
}

/**
 * Whether a step ended without an answer. A step that stops on reasoning alone
 * never wrote anything the turn (or the reader) can act on, and one the provider
 * cut at the harness's own output cap stopped mid-word — both are a broken
 * chain. Ending the turn there is what leaves a chat silent with the work
 * unfinished and makes the user type "продолжай" to get an answer.
 */
function cutBeforeAnswer(response: ModelMessage[], stopReason: TurnStopReason): boolean {
  if (stopReason === "max_tokens") return true;
  const last = response[response.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return false;
  return !last.content.some((part) => part.type === "text" || part.type === "tool-call");
}

function toStopReason(finishReason: string): TurnStopReason {
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "content-filter" || finishReason === "tool-approval-required") return "stop_sequence";
  if (finishReason === "refusal") return "refusal";
  return "end_turn";
}

/**
 * Safety valve for the tool loop: `isLoopFinished()` never stops, so a model
 * that keeps calling tools would run until the user kills the chat. Natural
 * termination (a step with no tool calls) still wins well below this.
 */
// A turn ends when the model stops calling tools. The ceiling below is not a
// working limit — it only catches a runaway loop; the user-facing bound is the
// Stop button / session cancel, and the token cost is bounded by the context
// window plus the provider bill.
const MAX_TOOL_STEPS = 10_000;

/**
 * Soft step budget for callers that hand the turn a wrap-up continuation: at
 * this many steps the turn ends with `stepBudgetHit`, the caller tells the
 * model to finish, and one short continuation turn completes the work. A
 * real rollout dies at an external wall-clock kill with the work unfinished —
 * this converts that death into a final answer. Calibrated against that
 * death: the observed kill case made 98 calls in 44 minutes, so 120 would
 * fire too late; 80 lands ~30 minutes in. Median tasks run 30–60 steps.
 */
export const WRAP_UP_STEPS = 80;
/** Steps the wrap-up continuation itself gets. */
export const WRAP_UP_EXTRA_STEPS = 40;

/**
 * Output cap, pi's and omp's number: a step that writes a 60KB file still fits,
 * but a runaway completion (or a reasoning stream that never lands) stops here
 * instead of burning the window. Uncapped output is the one token leak the
 * model itself cannot cause without the harness signing off on it.
 */
const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Liveness tick during a long tool run: the host's ACP request timeout reads
 * silence as a hang, and a tool (a `[js]` model eval, a build) can hold the
 * wire quiet for many minutes. One `heartbeat` update per interval while a
 * tool is in flight keeps that wait extended without inventing content.
 */
export const HEARTBEAT_MS = 60_000;

/** One assistant turn: stream text/thinking into ACP updates and run tools. */
export async function runTurn(opts: TurnOptions): Promise<TurnOutcome> {
  const maxSteps = opts.maxSteps ?? MAX_TOOL_STEPS;
  const outputCap = opts.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const reasoningLimit = opts.reasoningLimitChars ?? 0;
  const injected: Array<{ at: number; message: ModelMessage }> = [];
  // The reasoning fuse owns the controller the SDK listens to: a cut kills
  // THIS model call mid-think, not the turn — the caller's cancel signal is
  // forwarded through and still kills everything.
  const cut = new AbortController();
  const forwardAbort = () => cut.abort(opts.abortSignal.reason);
  if (opts.abortSignal.aborted) forwardAbort();
  else opts.abortSignal.addEventListener("abort", forwardAbort, { once: true });
  // Reasoning streamed by the step being cut — kept so the aborted step's
  // thinking reaches the history instead of vanishing with the call.
  let stepReasoning = "";
  // Once the step starts acting (text or a tool call) the fuse stands down:
  // a half-streamed answer or call is never torn apart by a thinking cap.
  let stepActed = false;
  let reasoningCut = false;
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    abortSignal: cut.signal,
    stopWhen: isStepCount(maxSteps),
    // 0 = the provider's own ceiling: the key must not go out at all.
    ...(outputCap > 0 ? { maxOutputTokens: outputCap } : {}),
    maxRetries: 2,
    // `afterStep` arrives here: a message the host sent mid-turn is appended to
    // the next model call. `responseMessages` counts what the turn has produced
    // so far, so `at` is exactly where the folded message belongs in history.
    ...(opts.takeSteer
      ? {
          prepareStep: (step: { messages: ModelMessage[]; responseMessages: readonly unknown[] }) => {
            const taken = opts.takeSteer!();
            if (!taken.length) return {};
            const at = step.responseMessages.length;
            taken.forEach((entry, i) => {
              injected.push({ at: at + i, message: entry.message });
              entry.ack();
            });
            return { messages: [...step.messages, ...taken.map((entry) => entry.message)] };
          },
        }
      : {}),
  });

  let failure: Error | undefined;
  // Billing this turn already put on the wire through its `finish-step` reports
  // — one per call as it lands. The closing report adds only what is left of
  // the turn's bill, so a harness that stores the latest update instead of
  // summing them never sees the same call charged twice, and a turn's totals
  // never come out below the steps already shown.
  let steppedInput = 0;
  let steppedOutput = 0;
  let steppedCached = 0;
  // Heartbeat while tools run: the SDK executes tools between the `tool-call`
  // and `tool-result` parts, so no other frame crosses the wire in that span.
  // The interval lives only between those parts and is always cleared — a
  // leak would keep ticking after the turn is over.
  const inFlightTools = new Set<string>();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = () => {
    if (heartbeat != null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  const syncHeartbeat = () => {
    if (inFlightTools.size === 0) {
      stopHeartbeat();
      return;
    }
    if (heartbeat != null) return;
    heartbeat = setInterval(() => {
      opts.emit({ sessionUpdate: "heartbeat" });
    }, heartbeatMs);
  };
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "start-step":
          // A fresh model call: the fuse re-arms with an empty budget.
          stepReasoning = "";
          stepActed = false;
          break;
        case "text-delta":
          stepActed = true;
          if (part.text) {
            opts.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part.text } });
          }
          break;
        case "reasoning-delta":
          if (part.text) {
            opts.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.text } });
            if (reasoningLimit > 0 && !reasoningCut && !stepActed) {
              stepReasoning += part.text;
              if (stepReasoning.length > reasoningLimit) {
                // The fuse fires: this call is cut mid-think. What it thought
                // stays in `stepReasoning` and goes into the history below.
                reasoningCut = true;
                opts.emit({
                  sessionUpdate: "agent_thought_chunk",
                  content: {
                    type: "text",
                    text: `\n[размышления обрезаны по лимиту ${reasoningLimit} символов — действуй по тому, что уже понял]`,
                  },
                });
                cut.abort(new Error(`reasoning limit ${reasoningLimit} chars exceeded`));
              }
            }
          }
          break;
        case "tool-call": {
          stepActed = true;
          const input = (part.input ?? {}) as Record<string, unknown>;
          opts.emit({
            sessionUpdate: "tool_call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            title: toolTitle(part.toolName, input),
            status: "in_progress",
            rawInput: input,
          });
          inFlightTools.add(part.toolCallId);
          syncHeartbeat();
          break;
        }
        case "tool-result":
          opts.emit({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "completed" });
          inFlightTools.delete(part.toolCallId);
          syncHeartbeat();
          break;
        case "tool-error":
          // A failing tool is information for the model, not a failed turn.
          opts.emit({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "failed" });
          inFlightTools.delete(part.toolCallId);
          syncHeartbeat();
          break;
        case "finish-step": {
          // A finished call already knows the window it filled. Reporting it here
          // — not only in the turn's own report below — is what keeps the context
          // chip alive while the agent works: a chat that thinks and runs tools
          // for minutes would otherwise show no context at all until the turn is
          // over. Same measure as the final report: this call's prompt + output,
          // never the turn-wide sum.
          const usage = part.usage;
          const used = Number(usage?.totalTokens ?? 0) || 0;
          if (used > 0 && opts.contextWindow > 0) {
            const input = Number(usage?.inputTokens ?? 0) || 0;
            const output = Number(usage?.outputTokens ?? 0) || 0;
            const cached = Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) || 0;
            steppedInput += input;
            steppedOutput += output;
            steppedCached += cached;
            opts.emit({
              sessionUpdate: "usage_update",
              used,
              size: opts.contextWindow,
              inputTokens: input,
              outputTokens: output,
              cachedInputTokens: cached,
            });
          }
          break;
        }
        case "error":
          // After the fuse fired, the stream dies on our own abort — reading
          // that as a provider failure would retry the turn instead of
          // continuing it with the reminder.
          if (!reasoningCut) failure ??= describeStreamError(part.error);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    // The fuse's own abort tears the stream down with the SDK's "Failed to
    // process successful response" APICallError (the cause is our abort
    // reason) — that is the cut, not a provider failure: the partial thinking
    // is folded below and the turn carries on through the continuation. Any
    // other stream error keeps the old shape and propagates.
    if (!reasoningCut) throw err;
  } finally {
    // Turn over (or stream died): no heartbeat may outlive it.
    stopHeartbeat();
    inFlightTools.clear();
  }

  let response: ModelMessage[] = [];
  let finishReason = "stop";
  let stepCount = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let contextTokens = 0;
  try {
    const [produced, reason, usage, steps] = await Promise.all([
      result.responseMessages,
      result.finishReason,
      result.usage,
      result.steps,
    ]);
    response = produced;
    finishReason = String(reason ?? "stop");
    // Older SDK shapes (and mocks) may not carry the steps array.
    stepCount = Array.isArray(steps) ? steps.length : 0;
    // Since ai@7 `usage` is the sum over every step of the turn (`totalUsage`
    // is its deprecated alias) — the right shape for the billing fields.
    totalTokens = Number(usage?.totalTokens ?? 0) || 0;
    inputTokens = Number(usage?.inputTokens ?? 0) || 0;
    outputTokens = Number(usage?.outputTokens ?? 0) || 0;
    // Prompt-cache hits are the cheap part of the input: reported separately so
    // the chip and the bench can show what the provider actually had to read.
    cachedInputTokens = Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) || 0;
    // The context chip is about the live window, so it takes the last call's
    // prompt + output — the sum in `usage` would grow by a whole context
    // re-read with every tool step of the turn.
    const lastStep = Array.isArray(steps) ? steps[steps.length - 1] : undefined;
    contextTokens = Number(lastStep?.usage?.totalTokens ?? 0) || 0;
  } catch (err) {
    // A cancelled turn resolves nothing — the client already knows it cancelled.
    // The reasoning fuse's own abort is not a cancellation: the step's partial
    // thinking is kept below and the turn carries on through the continuation.
    // Otherwise the SDK's generic "No output generated" rejection hides the
    // real cause: the streamed error part captured above reaches the user.
    if (!opts.abortSignal.aborted && !reasoningCut) throw failure ?? err;
  }

  if (reasoningCut && stepReasoning.trim()) {
    // The cut step never reached a recorded message — its thinking lives only
    // in the stream we buffered. Fold it in as the step's own assistant
    // message: the continuation's request sends it back as `reasoning_content`
    // (the provider requires that anyway) and the model resumes from what it
    // had already worked out instead of thinking from scratch.
    response = [
      ...response,
      { role: "assistant", content: [{ type: "reasoning", text: stepReasoning }] },
    ];
  }

  if (totalTokens > 0 && opts.contextWindow > 0) {
    // What the step reports did not already carry — and never less than zero:
    // a provider whose turn sum falls under its own step reports must not turn
    // the report into a give-back. `used` still names the live window.
    const left = (whole: number, reported: number) => Math.max(0, whole - reported);
    opts.emit({
      sessionUpdate: "usage_update",
      used: contextTokens || totalTokens,
      size: opts.contextWindow,
      inputTokens: left(inputTokens, steppedInput),
      outputTokens: left(outputTokens, steppedOutput),
      cachedInputTokens: left(cachedInputTokens, steppedCached),
    });
  }

  const stopReason = toStopReason(finishReason);
  return {
    response,
    stopReason,
    ...(reasoningCut ? { reasoningLimitHit: true } : {}),
    ...(stepCount >= maxSteps && !opts.abortSignal.aborted ? { stepBudgetHit: true } : {}),
    // A reasoning cut always ends on a reasoning-only tail, but its remedy is
    // the reminder-continuation, not the generic "continue" — no double flag.
    ...(cutBeforeAnswer(response, stopReason) && !opts.abortSignal.aborted && !reasoningCut
      ? { truncated: true }
      : {}),
    ...(failure && !opts.abortSignal.aborted ? { failure } : {}),
    ...(injected.length ? { injected } : {}),
  };
}

/** Attempts per turn: the original plus reruns after a dead stream. */
export const MAX_TURN_ATTEMPTS = 5;

/**
 * Continuations per turn: a step the model never finished is re-driven this
 * many times before the turn is given up on. Small on purpose — a model stuck
 * in a degenerate loop would otherwise spin the harness forever, and the step
 * after each continuation reads the same history plus the nudge.
 */
export const MAX_TURN_CONTINUATIONS = 2;

/**
 * Backoff between turn retries — a gateway blip passes in seconds, a dead
 * upstream needs longer, so the wait grows: 2s, 6s, 10s, 20s. The list is
 * indexed by attempt and clamped, so a raised attempts cap keeps waiting the
 * last (longest) step.
 */
const RETRY_PAUSE_MS = [2_000, 6_000, 10_000, 20_000];

/**
 * Rerun a turn whose stream died mid-flight, and carry on one whose step ended
 * without an answer. `runTurn` throws before any response message exists, so the
 * caller's history is still exact and the same turn can simply run again.
 * Without this, one dropped stream from a flaky endpoint ends the whole session
 * on a harness error with the work lost — a real SWE-bench rollout died 64
 * seconds in with an empty patch — and a step the model stopped on reasoning
 * alone ends the chat with the user typing "продолжай" to get an answer.
 */
export async function runTurnWithRetry(
  run: () => Promise<TurnOutcome>,
  opts: {
    signal: AbortSignal;
    attempts: number;
    note: (message: string) => void;
    /**
     * Handed every attempt that still produced messages — a failed stream and a
     * cut step alike — so the caller can fold them before the rerun, and keep
     * the last attempt's when all of them end that way.
     */
    keepPartial?: (outcome: TurnOutcome) => void;
    /**
     * Called after a cut step was folded, so the caller can put the nudge that
     * tells the model to carry on into its own history — the history belongs to
     * the caller, and the rerun reads it. Without the nudge the model reads its
     * own cut-off output as the answer and stops again.
     */
    continueAfter?: (outcome: TurnOutcome) => void;
    /** Continuations a cut turn gets. Defaults to {@link MAX_TURN_CONTINUATIONS}. */
    continuations?: number;
  },
): Promise<TurnOutcome> {
  const maxContinuations = opts.continuations ?? MAX_TURN_CONTINUATIONS;
  let continuations = 0;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: TurnOutcome;
    try {
      outcome = await run();
    } catch (err) {
      if (attempt >= opts.attempts || opts.signal.aborted) throw err;
      opts.note(
        `Ход прерван ошибкой провайдера (${firstLineError(err)}); повторяю ход ` +
          `(${attempt + 1} из ${opts.attempts}).`,
      );
      await pause(RETRY_PAUSE_MS[Math.min(attempt - 1, RETRY_PAUSE_MS.length - 1)], opts.signal);
      if (opts.signal.aborted) throw err;
      continue;
    }
    // A stream that died after producing messages does not throw: the outcome
    // carries `failure`, and the work it already produced must reach the caller
    // before the rerun continues from it. A step the model never finished is the
    // same shape — messages already produced, nothing to catch — and the work it
    // did produce is kept the same way. A reasoning cut is that shape too: the
    // step's thinking is folded in and the turn carries on with a reminder.
    if (!outcome.failure && !outcome.truncated && !outcome.reasoningLimitHit) return outcome;
    opts.keepPartial?.(outcome);
    if (outcome.failure) {
      if (attempt >= opts.attempts || opts.signal.aborted) return outcome;
      opts.note(
        `Ход прерван ошибкой провайдера (${firstLineError(outcome.failure)}); повторяю ход ` +
          `(${attempt + 1} из ${opts.attempts}).`,
      );
      await pause(RETRY_PAUSE_MS[Math.min(attempt - 1, RETRY_PAUSE_MS.length - 1)], opts.signal);
      if (opts.signal.aborted) return outcome;
      continue;
    }
    // Nothing failed — the model simply stopped before answering. The same turn
    // runs on from what it produced, told where it stopped, and no pause is
    // needed: there is no failing endpoint to wait out.
    continuations += 1;
    if (continuations > maxContinuations || opts.signal.aborted) return outcome;
    opts.continueAfter?.(outcome);
    opts.note(
      `Ход оборвался, не дойдя до ответа; продолжаю с того места, где остановилась модель ` +
        `(${continuations} из ${maxContinuations}).`,
    );
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** One line, for the retry note — a stream error can carry a response body. */
function firstLineError(err: unknown): string {
  const message = (err instanceof Error ? err.message : String(err)).split("\n", 1)[0] ?? "";
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
