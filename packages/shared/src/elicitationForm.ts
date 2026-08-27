export type ElicitationSchemaProperty = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string; description?: string }>;
  items?: { anyOf?: Array<{ const?: unknown; title?: string; description?: string }> };
};

export type ElicitationRequestedSchema = {
  type?: string;
  properties?: Record<string, ElicitationSchemaProperty>;
  required?: string[];
};

export type ElicitationFormQuestion = {
  id: string;
  prompt: string;
  description?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  allowMultiple?: boolean;
  freeTextField?: string;
  freeTextLabel?: string;
  textInput?: boolean;
  booleanChoice?: boolean;
  defaultValue?: string;
};

export type ElicitationQuestionPayload = {
  title: string;
  questions: ElicitationFormQuestion[];
  requestedSchema: ElicitationRequestedSchema;
};

export type ElicitationUiAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  freeText?: string;
};

function schemaOptionEntries(prop: ElicitationSchemaProperty) {
  if (Array.isArray(prop.oneOf) && prop.oneOf.length) {
    return prop.oneOf.map((entry) => ({
      id: String(entry.const ?? entry.title ?? ""),
      label: String(entry.title ?? entry.const ?? ""),
      description: entry.description ? String(entry.description) : undefined,
    }));
  }
  if (Array.isArray(prop.enum) && prop.enum.length) {
    return prop.enum.map((value) => {
      const label = String(value);
      return { id: label, label };
    });
  }
  if (prop.type === "array" && Array.isArray(prop.items?.anyOf) && prop.items.anyOf.length) {
    return prop.items.anyOf.map((entry) => ({
      id: String(entry.const ?? entry.title ?? ""),
      label: String(entry.title ?? entry.const ?? ""),
      description: entry.description ? String(entry.description) : undefined,
    }));
  }
  return [];
}

/** Map ACP form elicitation schema to the inline question UI payload. */
export function elicitationSchemaToQuestionPayload(
  message: string,
  requestedSchema: ElicitationRequestedSchema,
): ElicitationQuestionPayload {
  const properties = requestedSchema.properties ?? {};
  const questions: ElicitationFormQuestion[] = [];

  for (const [key, rawProp] of Object.entries(properties)) {
    if (key.endsWith("__other")) continue;
    const prop = rawProp ?? {};
    const otherKey = `${key}__other`;
    const otherProp = properties[otherKey];
    const prompt = String(prop.title ?? message).trim() || message;
    const description = prop.description ? String(prop.description).trim() : undefined;

    if (prop.type === "boolean" && Object.keys(properties).length === 1) {
      questions.push({
        id: key,
        prompt,
        description,
        options: [],
        booleanChoice: true,
      });
      continue;
    }

    const options = schemaOptionEntries(prop);
    if (options.length === 0 && prop.type === "string") {
      questions.push({
        id: key,
        prompt,
        description,
        options: [],
        textInput: true,
        defaultValue: prop.default == null ? undefined : String(prop.default),
        ...(otherProp
          ? {
              freeTextField: otherKey,
              freeTextLabel: String(otherProp.title ?? "").trim() || undefined,
            }
          : {}),
      });
      continue;
    }

    questions.push({
      id: key,
      prompt,
      description,
      options,
      allowMultiple: prop.type === "array",
      defaultValue: prop.default == null ? undefined : String(prop.default),
      ...(otherProp
        ? {
            freeTextField: otherKey,
            freeTextLabel: String(otherProp.title ?? "").trim() || undefined,
          }
        : {}),
    });
  }

  return {
    title: message.trim() || questions[0]?.prompt || "Question",
    questions,
    requestedSchema,
  };
}

/** Convert inline UI answers back to ACP `elicitation/create` accept content. */
export function elicitationContentFromUiAnswers(
  payload: ElicitationQuestionPayload,
  answers: ElicitationUiAnswer[],
): Record<string, unknown> {
  const byId = new Map(answers.map((row) => [row.questionId, row]));
  const content: Record<string, unknown> = {};

  for (const question of payload.questions) {
    const answer = byId.get(question.id);
    const selected = answer?.selectedOptionIds ?? [];
    const freeText = answer?.freeText?.trim() ?? "";

    if (question.booleanChoice) {
      const pick = selected[0];
      content[question.id] = pick === "true";
      continue;
    }

    if (question.textInput && !question.options.length) {
      content[question.id] = freeText || selected[0] || question.defaultValue || "";
      if (question.freeTextField && freeText) {
        content[question.freeTextField] = freeText;
      }
      continue;
    }

    if (question.allowMultiple) {
      content[question.id] = selected;
      continue;
    }

    if (question.freeTextField && freeText) {
      content[question.freeTextField] = freeText;
      continue;
    }

    if (selected[0]) {
      content[question.id] = selected[0];
    }
  }

  return content;
}

export function elicitationResponseFromUiOutcome(
  payload: ElicitationQuestionPayload,
  outcome: Record<string, unknown>,
):
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" } {
  const inner = (outcome.outcome ?? outcome) as Record<string, unknown>;
  const kind = String(inner.outcome ?? "");

  if (kind === "skipped" || kind === "cancelled") {
    return { action: "cancel" };
  }
  if (kind === "rejected") {
    return { action: "decline" };
  }

  const answers = Array.isArray(inner.answers)
    ? (inner.answers as Array<Record<string, unknown>>).map((row) => ({
        questionId: String(row.questionId ?? ""),
        selectedOptionIds: Array.isArray(row.selectedOptionIds)
          ? row.selectedOptionIds.map(String)
          : [],
        freeText: typeof row.freeText === "string" ? row.freeText : undefined,
      }))
    : [];

  return {
    action: "accept",
    content: elicitationContentFromUiAnswers(payload, answers),
  };
}
