export type QuestionAnswerPayload = {
  title?: string;
  questions?: Array<{
    id: string;
    prompt?: string;
    options?: Array<{ id: string; label: string }>;
  }>;
  result?: Record<string, unknown>;
  /** Persisted summary so answered cards survive reloads even if result shape shifts. */
  answerSummary?: string;
};

/** Human-readable summary of an inline question answer for the thread history. */
export function summarizeQuestionAnswer(payload: QuestionAnswerPayload): string {
  const stored = String(payload.answerSummary ?? "").trim();
  if (stored) return stored;

  const outcome = (payload.result?.outcome ?? payload.result) as Record<string, unknown> | undefined;
  if (!outcome) return String(payload.title ?? "").trim();
  const kind = String(outcome.outcome ?? "");
  if (kind === "skipped" || kind === "cancelled") return "—";
  // The reader's own words are the answer whenever they typed them — the plan
  // card's «Отклонить» sends them as the rejection's reason.
  if (kind === "rejected") {
    const reason = typeof outcome.reason === "string" ? outcome.reason.trim() : "";
    return reason || "✗";
  }
  const answers = Array.isArray(outcome.answers)
    ? (outcome.answers as Array<Record<string, unknown>>)
    : [];
  const questions = payload.questions ?? [];
  const bits = answers.map((row) => {
    const q = questions.find((item) => item.id === row.questionId);
    const selected = Array.isArray(row.selectedOptionIds)
      ? row.selectedOptionIds.map(String)
      : [];
    const freeText = typeof row.freeText === "string" ? row.freeText.trim() : "";
    if (freeText) return freeText;
    if (selected.length === 0) return "";
    return selected
      .map((id) => q?.options?.find((opt) => opt.id === id)?.label ?? id)
      .filter(Boolean)
      .join(", ");
  });
  return bits.filter(Boolean).join(" · ") || String(payload.title ?? "").trim();
}
