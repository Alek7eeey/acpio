/**
 * The mode a chat sends its prompts in. It is not a switch on the agent: every
 * non-agent mode is an ordinary `SKILL.md` (`plan`, `ask`, `investigate`), so
 * the mode only decides whether `/<name> ` goes in front of the reader's words.
 * That prefix is what reaches the wire and the stored message — the bubble
 * hides it again and shows the mode instead (see {@link composerModeOf}), so
 * the skill behind a mode stays invisible to the reader.
 */
export type ComposerMode = "agent" | "plan" | "ask" | "investigate";

/** Every mode, in the order the field's menu offers them. */
export const COMPOSER_MODES: readonly ComposerMode[] = ["agent", "plan", "ask", "investigate"];

/** i18n keys of the mode names: the switcher, the model chip and the bubble
 *  label all say the same word. */
export const COMPOSER_MODE_LABEL_KEY: Record<ComposerMode, string> = {
  agent: "chat.modeAgent",
  plan: "chat.modePlan",
  ask: "chat.modeAsk",
  investigate: "chat.modeInvestigate",
};

/** The modes by session id, kept in the browser: a mode survives a reload. */
const STORAGE_KEY = "acpio.composerModes.v1";

function isComposerMode(value: unknown): value is ComposerMode {
  return typeof value === "string" && (COMPOSER_MODES as readonly string[]).includes(value);
}

export function readComposerModes(): Record<string, ComposerMode> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, ComposerMode> = {};
    for (const [sessionId, mode] of Object.entries(parsed as Record<string, unknown>)) {
      if (sessionId && isComposerMode(mode)) out[sessionId] = mode;
    }
    return out;
  } catch {
    return {}; // storage blocked or malformed: the chat opens in agent mode
  }
}

export function storeComposerMode(sessionId: string, mode: ComposerMode) {
  try {
    const all = readComposerModes();
    // Agent is the default the reader returns to: in the file it is an absence,
    // so a mode a chat left behind cannot come back as a surprise.
    if (mode === "agent") delete all[sessionId];
    else all[sessionId] = mode;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A browser that refuses storage only loses the mode on reload.
  }
}

/** `agent` is the absence of a prefix: those prompts go out exactly as typed. */
export function withComposerMode(text: string, mode: ComposerMode = "agent"): string {
  if (mode === "agent") return text;
  // An explicit command is the reader's own instruction: `/compact` typed in
  // plan mode stays a compaction, not a plan.
  if (text.trimStart().startsWith("/")) return text;
  return `/${mode} ${text}`;
}

const MODE_PREFIX_RE = /^\/(plan|ask|investigate)(?:\s+|$)/i;

/** The mode a stored user message was sent in, read off its own prefix. */
export function composerModeOf(text: string): ComposerMode {
  const matched = MODE_PREFIX_RE.exec(text)?.[1]?.toLowerCase();
  return matched === "plan" || matched === "ask" || matched === "investigate" ? matched : "agent";
}

/** The message as the reader typed it: the skill token was never their words. */
export function stripComposerMode(text: string): string {
  return text.replace(MODE_PREFIX_RE, "");
}
