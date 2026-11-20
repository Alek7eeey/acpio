import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILTIN_CONTEXT_MODES,
  BUILTIN_REASONING_POLICIES,
  normalizeBuiltinSubagents,
  type BuiltinContextMode,
  type BuiltinReasoningPolicy,
  type BuiltinSubagentsSetting,
} from "@acpio/shared";
import type { ModelMessage } from "ai";

/**
 * The prompt mode the composer's ⋯ menu picks (`prompt_style`, once `thinking`).
 * It lives here because it is part of the frozen head: the mode's rider is the
 * last block of the system prompt, so flipping it mid-chat rewrote `messages[0]`
 * and made the provider bill the whole history again.
 */
export const PROMPT_THINKING_MODES = ["high", "default", "low", "extra-low"] as const;
export type PromptThinkingMode = (typeof PROMPT_THINKING_MODES)[number];

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
   * Wire reasoning effort of this chat (`reasoning_effort`): a level the model
   * declares, `off`/`none` for no thinking pass at all, or `default` (absent)
   * to leave the field out and let the endpoint decide.
   */
  effort?: string;
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
  /**
   * Where each of the harness's user turns begins in `messages`, keyed by that
   * turn's id in the chat. Stored so an edit can cut this history at the turn it
   * rewrites instead of throwing the whole session away: the chat's message id
   * is the only name the two sides share.
   */
  turns?: Record<string, number>;
  /** Where the prune mode view starts; sticky until the view outgrows the line. */
  prunedFrom?: number;
  /**
   * Stored-message boundary whose archive decision is already taken: a result
   * below it went out either verbatim or as the citation its archive file
   * holds, and rewriting it now would move the head of every later request.
   * Absent on a session stored before the field existed — every result of that
   * history has been sent, so the reader seals all of it.
   */
  offloadUpTo?: number;
  /**
   * Whether this chat's requests carry the reasoning echo, as its first request
   * decided it. The field is added to every assistant message that has none, so
   * taking the decision again rewrites the bytes of messages that already
   * crossed the wire: chat b5852ea0 sent 67 messages, gained the field on one
   * acting step it had sent bare, and the provider answered 2 of them from its
   * cache — the other 66 were billed again by a steer, which ends a turn and
   * starts another one. Absent on a history stored before the field existed.
   */
  echoReasoning?: boolean;
  /**
   * Session-to-date token spend — what the context panel's in/cached/out rows
   * report. Stored so a restart resumes the totals instead of handing the panel
   * a smaller number than the session has already spent.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    /** Requests an unchanged head paid for in full — the provider's own miss. */
    coldMisses?: number;
    /** Input tokens those requests were billed for. */
    coldMissTokens?: number;
  };
  /**
   * The skills half of the system prompt as this chat's first turn fixed it: the
   * inlined bodies of the active skills and the rules they stand in for. Stored
   * so a transport built again mid-chat — a settings change, a restart — resumes
   * on the same bytes instead of rewriting the head of every later request.
   */
  promptSkills?: { section: string; supersedes: string[] };
  /**
   * The project-rules block as the session's first turn fixed it, plus the rule
   * paths already appended to the tail as notes. Stored for the same reason as
   * `promptSkills`: a transport built again mid-chat must resume on the bytes the
   * provider's cache has, and a note that landed once may not land twice.
   */
  promptRules?: { section: string; delivered: string[] };
  /**
   * The settings the rest of the head was written from — the answer language,
   * the two prompt switches, the plan tool and the MCP servers the prompt names.
   * Stored with the session for the same reason as `promptSkills`: the system
   * prompt and the tool declarations ride ahead of the messages, so a transport
   * built again mid-chat has to resume on the bytes the provider caches, not on
   * the settings as they stand now.
   */
  promptHead?: {
    locale: string;
    replyLanguage: "auto" | "en" | "ru";
    /**
     * The ⋯ menu's prompt mode. Its rider is the *last* block of the system
     * prompt, which is still inside `messages[0]`: a switch mid-chat moved the
     * head and billed the whole history again, so it is frozen with the rest.
     */
    thinking: PromptThinkingMode;
    planTool: boolean;
    outsideCwd: boolean;
    markdownImages: boolean;
    extraInstructions: string;
    servers: string[];
    /**
     * The context tiers `promptHistory` renders the view with. They are not the
     * head, but they rewrite messages the head stands in front of — a mask policy
     * flipped mid-chat puts previously sent results back on the wire in another
     * shape, and the cache breaks at the first one.
     */
    contextMode: BuiltinContextMode;
    pruneReasoning: BuiltinReasoningPolicy;
    respectReasoningHistory: boolean;
    /**
     * The subagents feature as the first turn read it: `task` is declared from
     * this roster, so a subagent added mid-chat arrives with the next chat.
     */
    subagents: BuiltinSubagentsSetting;
  };
}

/** Session ids become file names, so never trust one blindly. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids are used as file names and ACP parameters — same rule everywhere. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * The file a session lives in. Exported for the boot's own diagnostic: a restore
 * that came back empty has to say whether the file was missing or unreadable.
 */
export function builtinSessionFile(stateDir: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Некорректный id сессии: ${sessionId}`);
  return join(stateDir, `${sessionId}.json`);
}

export function loadBuiltinSession(stateDir: string, sessionId: string): BuiltinStoredSession | undefined {
  try {
    const parsed = JSON.parse(readFileSync(builtinSessionFile(stateDir, sessionId), "utf8")) as Partial<BuiltinStoredSession>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return undefined;
    const compaction = parsed.compaction;
    const startedAt = (value: unknown, length: number) =>
      Number.isInteger(value) && (value as number) >= 0 && (value as number) <= length
        ? (value as number)
        : undefined;
    const maskUpTo = startedAt(parsed.maskUpTo, parsed.messages.length);
    // A point outside the stored history describes a file that has since been
    // cut — dropping it is what makes a rewind of a rewound file read as
    // "unknown point" instead of cutting at the wrong message.
    const storedCount = parsed.messages.length;
    const turns = Object.fromEntries(
      Object.entries(
        parsed.turns && typeof parsed.turns === "object" && !Array.isArray(parsed.turns)
          ? (parsed.turns as Record<string, unknown>)
          : {},
      ).filter(
        ([id, at]) =>
          /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
          Number.isInteger(at) &&
          (at as number) >= 0 &&
          (at as number) < storedCount,
      ),
    ) as Record<string, number>;
    const prunedFrom = startedAt(parsed.prunedFrom, parsed.messages.length);
    const offloadUpTo = startedAt(parsed.offloadUpTo, parsed.messages.length);
    const thinkingOff = parsed.thinkingOff === true;
    const echoReasoning = typeof parsed.echoReasoning === "boolean" ? parsed.echoReasoning : undefined;
    const effort =
      typeof parsed.effort === "string" && /^[a-z0-9_-]{1,32}$/i.test(parsed.effort.trim())
        ? parsed.effort.trim()
        : undefined;
    const thinkingLimitRaw = parsed.thinkingLimit;
    const thinkingLimit =
      typeof thinkingLimitRaw === "number" &&
      Number.isInteger(thinkingLimitRaw) &&
      thinkingLimitRaw >= 0 &&
      thinkingLimitRaw <= 1_000_000
        ? thinkingLimitRaw
        : undefined;
    const skills = parsed.promptSkills;
    const promptSkills =
      skills &&
      typeof skills.section === "string" &&
      Array.isArray(skills.supersedes) &&
      skills.supersedes.every((id) => typeof id === "string")
        ? { section: skills.section, supersedes: skills.supersedes as string[] }
        : undefined;
    const rules = parsed.promptRules;
    const promptRules =
      rules &&
      typeof rules.section === "string" &&
      Array.isArray(rules.delivered) &&
      rules.delivered.every((rule) => typeof rule === "string")
        ? { section: rules.section, delivered: rules.delivered as string[] }
        : undefined;
    const stored = parsed.usage;
    // A head with one broken field reads as "no frozen head": the first turn
    // writes it again from the settings instead of resuming on half a prompt.
    const headRaw = parsed.promptHead;
    const promptHead =
      headRaw &&
      typeof headRaw.locale === "string" &&
      (headRaw.replyLanguage === "auto" || headRaw.replyLanguage === "en" || headRaw.replyLanguage === "ru") &&
      (PROMPT_THINKING_MODES as readonly string[]).includes(headRaw.thinking) &&
      typeof headRaw.planTool === "boolean" &&
      typeof headRaw.outsideCwd === "boolean" &&
      typeof headRaw.markdownImages === "boolean" &&
      typeof headRaw.extraInstructions === "string" &&
      Array.isArray(headRaw.servers) &&
      headRaw.servers.every((server) => typeof server === "string") &&
      (BUILTIN_CONTEXT_MODES as readonly string[]).includes(headRaw.contextMode) &&
      (BUILTIN_REASONING_POLICIES as readonly string[]).includes(headRaw.pruneReasoning) &&
      typeof headRaw.respectReasoningHistory === "boolean" &&
      !!headRaw.subagents &&
      typeof headRaw.subagents === "object"
        ? {
            locale: headRaw.locale,
            replyLanguage: headRaw.replyLanguage,
            thinking: headRaw.thinking as PromptThinkingMode,
            planTool: headRaw.planTool,
            outsideCwd: headRaw.outsideCwd,
            markdownImages: headRaw.markdownImages,
            extraInstructions: headRaw.extraInstructions,
            servers: headRaw.servers as string[],
            contextMode: headRaw.contextMode as BuiltinContextMode,
            pruneReasoning: headRaw.pruneReasoning as BuiltinReasoningPolicy,
            respectReasoningHistory: headRaw.respectReasoningHistory,
            subagents: normalizeBuiltinSubagents(headRaw.subagents),
          }
        : undefined;
    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const usageInput = count(stored?.inputTokens);
    const usageOutput = count(stored?.outputTokens);
    const usageCached = count(stored?.cachedInputTokens);
    const coldMisses = count(stored?.coldMisses);
    const coldMissTokens = count(stored?.coldMissTokens);
    return {
      version: 1,
      cwd: String(parsed.cwd ?? ""),
      modelId: String(parsed.modelId ?? ""),
      // Pictures this file keeps beside itself come back as bytes: a chat that
      // resumes on a text placeholder rewrites messages the provider already
      // cached (see `spillImages`).
      messages: restoreImages(stateDir, parsed.messages as ModelMessage[]),
      ...(thinkingOff ? { thinkingOff: true } : {}),
      ...(effort && effort !== "default" ? { effort } : {}),
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
      ...(Object.keys(turns).length ? { turns } : {}),
      ...(prunedFrom !== undefined ? { prunedFrom } : {}),
      ...(offloadUpTo !== undefined ? { offloadUpTo } : {}),
      ...(echoReasoning !== undefined ? { echoReasoning } : {}),
      // A half-written or hand-edited total reads as "unknown": the session
      // starts its spend rows over rather than trusting a broken figure.
      ...(usageInput !== undefined && usageOutput !== undefined && usageCached !== undefined
        ? {
            usage: {
              inputTokens: usageInput,
              outputTokens: usageOutput,
              cachedInputTokens: usageCached,
              ...(coldMisses !== undefined ? { coldMisses } : {}),
              ...(coldMissTokens !== undefined ? { coldMissTokens } : {}),
            },
          }
        : {}),
      ...(promptSkills ? { promptSkills } : {}),
      ...(promptRules ? { promptRules } : {}),
      ...(promptHead ? { promptHead } : {}),
    };
  } catch {
    // Missing or corrupt file: start fresh instead of bricking the session.
    return undefined;
  }
}

/** Folder of a chat's picture bytes, beside the session files they belong to. */
const IMAGE_DIR = "session-images";

/** Where one stored picture lives, relative to the state directory. */
function imageRelPath(sessionId: string, message: number, part: number, mediaType: string): string {
  const ext = (mediaType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "") || "bin";
  return `${IMAGE_DIR}/${sessionId}-${message}-${part}.${ext}`;
}

/**
 * Copy of the history safe to store: a picture's bytes move out of the JSON and
 * beside it, and the message keeps a reference to the file.
 *
 * The JSON used to grow by megabytes per attached screenshot, so older pictures
 * were replaced by a text placeholder — and that placeholder is a rewrite of a
 * message the provider had already cached: on the next turn the prefix ended at
 * the first old picture and the rest of the history was billed again (chat
 * 8294560b: `messages[3]` became "[изображение…]" at 11:12, the request body
 * fell from 443 KB to 148 KB, and the same picture read `[image]` from then on).
 * Writing the bytes to their own file keeps the session file small and the head
 * byte-identical: `restoreImages` inlines them again when the chat is reloaded.
 */
function spillImages(
  stateDir: string,
  sessionId: string,
  messages: ModelMessage[],
): ModelMessage[] {
  return messages.map((message, index) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part, partIndex) => {
      if (part.type !== "file" || typeof part.data !== "string" || !part.data) return part;
      const path = imageRelPath(sessionId, index, partIndex, String(part.mediaType ?? ""));
      try {
        mkdirSync(join(stateDir, IMAGE_DIR), { recursive: true });
        writeFileSync(join(stateDir, path), Buffer.from(part.data, "base64"));
      } catch {
        // A picture that could not be spilled stays inline: the history is
        // worth more than the size of the session file.
        return part;
      }
      changed = true;
      return { type: "file" as const, mediaType: part.mediaType, data: "", path };
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * The other half of `spillImages`: a stored reference becomes the bytes again, so
 * a reloaded chat sends the picture the earlier turns were answered with — the
 * same bytes the provider has cached. A file somebody deleted falls back to the
 * placeholder older sessions already carry.
 */
function restoreImages(stateDir: string, messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part) => {
      const stored = part as unknown as { type?: string; path?: unknown; data?: unknown };
      if (stored.type !== "file" || typeof stored.path !== "string" || stored.data) return part;
      changed = true;
      try {
        const data = readFileSync(join(stateDir, stored.path)).toString("base64");
        return { ...(part as object), data } as unknown as (typeof message.content)[number];
      } catch {
        return {
          type: "text",
          text: "[изображение из предыдущего сообщения — не сохранено]",
        } as unknown as (typeof message.content)[number];
      }
    });
    return (changed ? { ...message, content } : message) as unknown as ModelMessage;
  });
}

/** Atomic replace — a crash mid-write must not leave a half-parsed history. */
export function saveBuiltinSession(stateDir: string, sessionId: string, data: BuiltinStoredSession): void {
  const file = builtinSessionFile(stateDir, sessionId);
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ ...data, messages: spillImages(stateDir, sessionId, data.messages) }),
    "utf8",
  );
  renameSync(tmp, file);
}
