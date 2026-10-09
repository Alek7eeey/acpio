import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

/** One conversation as the agent keeps it — enough to resume after a restart. */
export interface BuiltinStoredSession {
  version: 1;
  cwd: string;
  modelId: string;
  messages: ModelMessage[];
  /**
   * `/thinking off` was last used: requests carry a body that switches the
   * endpoint's thinking pass off. Session-level and separate from the
   * prompt-side mode the ⋯ menu picks.
   */
  thinkingOff?: boolean;
  /**
   * `/thinking-limit` override for this chat, chars of one step's private
   * reasoning before the fuse cuts the call. Absent = follow the global
   * `builtinThinkingLimit` setting, 0 = explicitly off here, >0 = the cap.
   */
  thinkingLimit?: number;
  /**
   * Digest of the history's covered prefix. It outlives the turn that wrote it,
   * so a restart neither re-summarises the same turns nor sends them verbatim.
   */
  compaction?: { summary: string; covered: number };
  /**
   * Stored-message boundary the notes cover. Kept so a restart resumes on the
   * same prompt bytes: losing it sends every already-noted result back into the
   * request and drops the cached prefix at the digest.
   */
  maskUpTo?: number;
  /** Where the prune mode view starts; sticky until the view outgrows the line. */
  prunedFrom?: number;
  /**
   * Session-to-date token spend — what the context panel's in/cached/out rows
   * report. Stored so a restart resumes the totals instead of handing the panel
   * a smaller number than the session has already spent.
   */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

/** Session ids become file names, so never trust one blindly. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids are used as file names and ACP parameters — same rule everywhere. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

function fileFor(stateDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Некорректный id сессии: ${sessionId}`);
  return join(stateDir, `${sessionId}.json`);
}

export function loadBuiltinSession(stateDir: string, sessionId: string): BuiltinStoredSession | undefined {
  try {
    const parsed = JSON.parse(readFileSync(fileFor(stateDir, sessionId), "utf8")) as Partial<BuiltinStoredSession>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return undefined;
    const compaction = parsed.compaction;
    const startedAt = (value: unknown, length: number) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= length
        ? (value as number)
        : undefined;
    const maskUpTo = startedAt(parsed.maskUpTo, parsed.messages.length);
    const prunedFrom = startedAt(parsed.prunedFrom, parsed.messages.length);
    const thinkingOff = parsed.thinkingOff === true;
    const thinkingLimitRaw = parsed.thinkingLimit;
    const thinkingLimit =
      typeof thinkingLimitRaw === "number" &&
      Number.isInteger(thinkingLimitRaw) &&
      thinkingLimitRaw >= 0 &&
      thinkingLimitRaw <= 1_000_000
        ? thinkingLimitRaw
        : undefined;
    const stored = parsed.usage;
    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const usageInput = count(stored?.inputTokens);
    const usageOutput = count(stored?.outputTokens);
    const usageCached = count(stored?.cachedInputTokens);
    return {
      version: 1,
      cwd: String(parsed.cwd ?? ""),
      modelId: String(parsed.modelId ?? ""),
      messages: parsed.messages as ModelMessage[],
      ...(thinkingOff ? { thinkingOff: true } : {}),
      ...(thinkingLimit !== undefined ? { thinkingLimit } : {}),
      // A digest pointing past the stored history describes a file that has
      // since been truncated — dropping it re-summarises instead of lying.
      ...(compaction &&
      typeof compaction.summary === "string" &&
      compaction.summary.trim() &&
      Number.isInteger(compaction.covered) &&
      compaction.covered > 0 &&
      compaction.covered <= parsed.messages.length
        ? { compaction: { summary: compaction.summary, covered: compaction.covered } }
        : {}),
      ...(maskUpTo !== undefined ? { maskUpTo } : {}),
      ...(prunedFrom !== undefined ? { prunedFrom } : {}),
      // A half-written or hand-edited total reads as "unknown": the session
      // starts its spend rows over rather than trusting a broken figure.
      ...(usageInput !== undefined && usageOutput !== undefined && usageCached !== undefined
        ? { usage: { inputTokens: usageInput, outputTokens: usageOutput, cachedInputTokens: usageCached } }
        : {}),
    };
  } catch {
    // Missing or corrupt file: start fresh instead of bricking the session.
    return undefined;
  }
}

/**
 * Copy of the history safe to store: image bytes survive only in the newest
 * user turn. The live history in memory is untouched, so the current turn keeps
 * every picture — this only stops one chat's JSON from growing by megabytes per
 * attached screenshot, forever. Older images were already in front of the model
 * when their turn ran; on restore they read as a text placeholder.
 */
function withoutOldImages(messages: ModelMessage[]): ModelMessage[] {
  let newestUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      newestUser = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (m.role !== "user" || i === newestUser || !Array.isArray(m.content)) return m;
    const content = m.content.map((part) =>
      part.type === "file"
        ? { type: "text" as const, text: "[изображение из предыдущего сообщения — не сохранено]" }
        : part,
    );
    return content.some((part, n) => part !== m.content[n]) ? { ...m, content } : m;
  });
}

/** Atomic replace — a crash mid-write must not leave a half-parsed history. */
export function saveBuiltinSession(stateDir: string, sessionId: string, data: BuiltinStoredSession): void {
  const file = fileFor(stateDir, sessionId);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ ...data, messages: withoutOldImages(data.messages) }),
    "utf8",
  );
  renameSync(tmp, file);
}
