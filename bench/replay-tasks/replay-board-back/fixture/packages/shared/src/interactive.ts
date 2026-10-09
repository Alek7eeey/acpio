/** One option on an ACP permission or ask_question prompt. */
export type InteractiveOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export function isToolPermissionOption(option: InteractiveOption): boolean {
  const id = option.optionId.toLowerCase();
  const kind = (option.kind ?? "").toLowerCase();
  if (kind.includes("allow") || kind.includes("reject") || kind.includes("deny")) return true;
  return /allow|reject|deny/i.test(id);
}

/** True when options look like a multi-choice question, not allow/deny tool consent. */
export function permissionOptionsLookLikeQuestion(options: InteractiveOption[]): boolean {
  if (options.length < 2) return false;
  return !options.every(isToolPermissionOption);
}

/** Build a ChatInlinePrompt-compatible ask_question payload from a permission request. */
export function questionPayloadFromPermission(
  params: Record<string, unknown>,
  options: InteractiveOption[],
): Record<string, unknown> {
  const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
  const title = String(params.title ?? toolCall.title ?? "").trim();
  const message = String(params.description ?? params.message ?? "").trim();
  const prompt = message || title || "";
  return {
    title: title || prompt || "Question",
    questions: [
      {
        id: "choice",
        prompt,
        options: options.map((o) => ({
          id: o.optionId,
          label: String(o.name ?? "").trim() || o.optionId,
        })),
      },
    ],
  };
}
