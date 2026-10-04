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
}

export interface TurnOutcome {
  /** Messages this turn produced — append them to the stored history. */
  response: ModelMessage[];
  stopReason: TurnStopReason;
  /** Model-call failure: output is already produced and must be persisted. */
  failure?: Error;
  /** The turn ended on the caller's step ceiling, not the model stopping —
   * the work is still in flight. See {@link WRAP_UP_STEPS}. */
  stepBudgetHit?: boolean;
}

/**
 * Keep only the newest messages that fit. Whole user-turn groups are dropped so
 * history never starts mid-tool-call — the SDK rejects a tool message whose
 * assistant call is missing, and a model misreads a truncated thread.
 * Estimation is chars/4 with a 20% safety margin: rough but one-directional.
 */
export function pruneMessages(messages: ModelMessage[], contextWindow: number): ModelMessage[] {
  if (!(contextWindow > 0)) return messages;
  const budget = contextWindow * 0.8;
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
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += JSON.stringify(message).length;
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

export interface CompactOptions {
  messages: ModelMessage[];
  contextWindow: number;
  /** Summarises the turns that no longer fit; may throw. */
  summarize: (dropped: ModelMessage[]) => Promise<string>;
}

/**
 * Prefer a summary over amnesia: past 80% of the window the oldest turns are
 * replaced by one model-written digest, keeping 60% of the window for the
 * recent, still-verbatim part. Storage is untouched — the caller keeps the full
 * history and only this turn's view is compacted. Any failure falls back to
 * {@link pruneMessages}, so a broken summariser never breaks a chat.
 */
export async function compactMessages(opts: CompactOptions): Promise<ModelMessage[]> {
  const { messages, contextWindow, summarize } = opts;
  if (!(contextWindow > 0) || estimateTokens(messages) <= contextWindow * 0.8) return messages;

  const cuts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === "user") cuts.push(i);
  }
  const keepBudget = contextWindow * 0.6;
  let cut = 0;
  for (const candidate of cuts) {
    if (estimateTokens(messages.slice(candidate)) <= keepBudget) {
      cut = candidate;
      break;
    }
  }
  if (!cut) return pruneMessages(messages, contextWindow);

  const dropped = messages.slice(0, cut);
  try {
    const summary = await summarize(dropped);
    if (!summary.trim()) return pruneMessages(messages, contextWindow);
    return [
      { role: "user", content: `${COMPACT_MARKER}\n\n${summary.trim()}` },
      ...messages.slice(cut),
    ];
  } catch {
    return pruneMessages(messages, contextWindow);
  }
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

/** One assistant turn: stream text/thinking into ACP updates and run tools. */
export async function runTurn(opts: TurnOptions): Promise<TurnOutcome> {
  const maxSteps = opts.maxSteps ?? MAX_TOOL_STEPS;
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    abortSignal: opts.abortSignal,
    stopWhen: isStepCount(maxSteps),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 2,
  });

  let failure: Error | undefined;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        if (part.text) {
          opts.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part.text } });
        }
        break;
      case "reasoning-delta":
        if (part.text) {
          opts.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.text } });
        }
        break;
      case "tool-call": {
        const input = (part.input ?? {}) as Record<string, unknown>;
        opts.emit({
          sessionUpdate: "tool_call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          title: toolTitle(part.toolName, input),
          status: "in_progress",
          rawInput: input,
        });
        break;
      }
      case "tool-result":
        opts.emit({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "completed" });
        break;
      case "tool-error":
        // A failing tool is information for the model, not a failed turn.
        opts.emit({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "failed" });
        break;
      case "error":
        failure ??= describeStreamError(part.error);
        break;
      default:
        break;
    }
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
    // Otherwise the SDK's generic "No output generated" rejection hides the
    // real cause: the streamed error part captured above reaches the user.
    if (!opts.abortSignal.aborted) throw failure ?? err;
  }

  if (totalTokens > 0 && opts.contextWindow > 0) {
    opts.emit({
      sessionUpdate: "usage_update",
      used: contextTokens || totalTokens,
      size: opts.contextWindow,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
  }

  return {
    response,
    stopReason: toStopReason(finishReason),
    ...(stepCount >= maxSteps && !opts.abortSignal.aborted ? { stepBudgetHit: true } : {}),
    ...(failure && !opts.abortSignal.aborted ? { failure } : {}),
  };
}

/** Attempts per turn: the original plus reruns after a dead stream. */
export const MAX_TURN_ATTEMPTS = 3;

/** Backoff between turn retries — enough for a gateway blip to pass. */
const RETRY_PAUSE_MS = [2_000, 6_000];

/**
 * Rerun a turn whose stream died mid-flight. `runTurn` throws before any
 * response message exists, so the caller's history is still exact and the same
 * turn can simply run again. Without this, one dropped stream from a flaky
 * endpoint ends the whole session on a harness error with the work lost —
 * a real SWE-bench rollout died 64 seconds in with an empty patch.
 */
export async function runTurnWithRetry(
  run: () => Promise<TurnOutcome>,
  opts: { signal: AbortSignal; attempts: number; note: (message: string) => void },
): Promise<TurnOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= opts.attempts || opts.signal.aborted) throw err;
      opts.note(
        `Ход прерван ошибкой провайдера (${firstLineError(err)}); повторяю ход ` +
          `(${attempt + 1} из ${opts.attempts}).`,
      );
      await pause(RETRY_PAUSE_MS[Math.min(attempt - 1, RETRY_PAUSE_MS.length - 1)], opts.signal);
      if (opts.signal.aborted) throw err;
    }
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
