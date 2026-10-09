// Normalizes what a pi-family harness (`pi`, `omp`) prints in `--mode json`:
// one JSON object per line, `message_end` / `tool_execution_end` per step.

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* a non-JSON line is a CLI notice, not an event */
    }
  }
  return out;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Turn-cumulative metrics. `tokensIn/Out/Total` sum across model calls, which is
 * the real spend; the last call's `totalTokens` is the context footprint.
 */
export function summarizeAgentStream(text) {
  const events = parseJsonl(text);
  const toolNames = new Map();
  const toolIds = new Set();
  let toolCalls = 0;
  let toolErrors = 0;
  let modelCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensTotal = 0;
  let tokensCached = 0;
  let cost = 0;
  let contextTokens = 0;
  let finalText = "";
  let stopReason = "";
  let sawToolEvent = false;

  for (const e of events) {
    if (e?.type === "tool_execution_end") {
      sawToolEvent = true;
      toolCalls += 1;
      if (e.isError) toolErrors += 1;
      if (e.toolCallId) toolIds.add(e.toolCallId);
      const name = String(e.toolName || "?");
      toolNames.set(name, (toolNames.get(name) || 0) + 1);
      continue;
    }
    if (e?.type === "error" && e.message) {
      stopReason = stopReason || "stream_error";
      continue;
    }
    if (e?.type !== "message_end" || !e.message) continue;
    const m = e.message;
    if (m.role === "assistant") {
      modelCalls += 1;
      const u = m.usage ?? {};
      tokensIn += num(u.input ?? u.promptTokens ?? u.prompt_tokens);
      tokensOut += num(u.output ?? u.completionTokens ?? u.completion_tokens);
      tokensTotal += num(u.totalTokens ?? u.total_tokens);
      tokensCached += num(
        u.cachedInputTokens ??
          u.cacheReadTokens ??
          u.cachedTokens ??
          u.prompt_tokens_details?.cached_tokens ??
          u.inputTokenDetails?.cacheReadTokens,
      );
      contextTokens = num(u.totalTokens ?? u.total_tokens) || contextTokens;
      cost += num(u.cost?.total ?? u.cost);
      const text = Array.isArray(m.content)
        ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("")
        : "";
      if (text) finalText = text;
      if (m.stopReason) stopReason = m.stopReason;
      continue;
    }
    // Older pi builds report tools only as toolResult messages.
    if (m.role === "toolResult" && !sawToolEvent && !(m.toolCallId && toolIds.has(m.toolCallId))) {
      toolCalls += 1;
      if (m.isError) toolErrors += 1;
      const name = String(m.toolName || "?");
      toolNames.set(name, (toolNames.get(name) || 0) + 1);
    }
  }

  return {
    eventCount: events.length,
    modelCalls,
    toolCalls,
    toolErrors,
    toolNames: Object.fromEntries(toolNames),
    tokensIn,
    tokensOut,
    tokensTotal,
    tokensCached,
    contextTokens,
    cost,
    finalText,
    stopReason,
  };
}
