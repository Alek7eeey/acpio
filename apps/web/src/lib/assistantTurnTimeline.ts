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

/** True when the final answer text is already on screen (post-tool only). */
export function turnAnswerVisible(parts: MessagePartDto[]): boolean {
  if (hasBlockingActiveTools(parts)) return false;
  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);
  if (toolOrder < 0) return false;
  return sorted.some(
    (p) =>
      p.type === "text" &&
      (p.order ?? 0) > toolOrder &&
      String(p.payload.text ?? "").trim().length > 0,
  );
}

/**
 * Final answer text for the turn. When tools ran, only text emitted after the
 * last tool counts — Cursor often sends a short status line before tool calls.
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
  if (toolOrder >= 0) return lastTextAfterTools;
  // Cursor may emit short status lines as text before any tool — keep them in the
  // timeline while the turn is still streaming.
  if (streaming) return null;
  return lastTextOverall;
}

/** @deprecated Prefer finalAnswerPart — kept for call sites that mean “final answer”. */
export function lastTextPart(parts: MessagePartDto[]): MessagePartDto | null {
  return finalAnswerPart(parts);
}

/** True while the phased timeline should stay up (tools running, pre-answer reasoning). */
export function stepsPartsStillLive(parts: MessagePartDto[], streaming: boolean): boolean {
  if (!streaming) return false;
  if (parts.length === 0) return true;

  const sorted = [...parts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const toolOrder = lastToolOrder(sorted);

  const finalText = finalAnswerPart(parts, { streaming });
  if (finalText && String(finalText.payload.text ?? "").trim().length > 0) {
    return false;
  }

  if (
    toolOrder >= 0 &&
    sorted.some(
      (p) =>
        (p.order ?? 0) > toolOrder &&
        p.type === "thought" &&
        String(p.payload.text ?? "").trim().length > 0,
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
