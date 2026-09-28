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
}

export interface TurnOutcome {
  /** Messages this turn produced — append them to the stored history. */
  response: ModelMessage[];
  stopReason: TurnStopReason;
  /** Model-call failure: output is already produced and must be persisted. */
  failure?: Error;
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
const MAX_TOOL_STEPS = 50;

/** One assistant turn: stream text/thinking into ACP updates and run tools. */
export async function runTurn(opts: TurnOptions): Promise<TurnOutcome> {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    abortSignal: opts.abortSignal,
    stopWhen: isStepCount(MAX_TOOL_STEPS),
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
        failure ??= toError(part.error);
        break;
      default:
        break;
    }
  }

  let response: ModelMessage[] = [];
  let finishReason = "stop";
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let contextTokens = 0;
  try {
    const [produced, reason, usage, lastStepUsage] = await Promise.all([
      result.responseMessages,
      result.finishReason,
      result.totalUsage,
      result.usage,
    ]);
    response = produced;
    finishReason = String(reason ?? "stop");
    totalTokens = Number(usage?.totalTokens ?? 0) || 0;
    inputTokens = Number(usage?.inputTokens ?? 0) || 0;
    outputTokens = Number(usage?.outputTokens ?? 0) || 0;
    // Prompt-cache hits are the cheap part of the input: reported separately so
    // the chip and the bench can show what the provider actually had to read.
    cachedInputTokens = Number(usage?.inputTokenDetails?.cacheReadTokens ?? 0) || 0;
    // The context chip is about the live window, so it takes the last step's
    // prompt + output, not the sum over every step of the turn.
    contextTokens = Number(lastStepUsage?.totalTokens ?? 0) || 0;
  } catch (err) {
    // A cancelled turn resolves nothing — the client already knows it cancelled.
    if (!opts.abortSignal.aborted) throw err;
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
    ...(failure && !opts.abortSignal.aborted ? { failure } : {}),
  };
}
