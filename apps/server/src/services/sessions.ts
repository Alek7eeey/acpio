import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, max, or, sql } from "drizzle-orm";
import type {
  MessageDto,
  MessagePartDto,
  MessagePartType,
  SessionDetailDto,
  SessionDto,
  AgentMode,
  AgentProvider,
  SessionStatus,
  AcpUsage,
} from "@acpio/shared";
import {
  canonicalCwd,
  modelForProvider,
  modelParamsForProvider,
  SHELL_SESSION_PROVIDER,
} from "@acpio/shared";
import { defaultSessionTitle } from "@acpio/i18n";
import { db } from "../db/client.js";
import { boardFolders, chatFolders, messageParts, messages, sessions } from "../db/schema.js";
import { broadcastToSession } from "./wsHub.js";
import { getSettings } from "./settings.js";
import { rememberFolders } from "./folders.js";

function mapSession(
  row: typeof sessions.$inferSelect,
  lastMessageAt?: Date | string | null,
): SessionDto {
  const createdAt = row.createdAt.toISOString();
  // Only a real message stamps activity. Empty chats keep "" so open/warm
  // cannot promote them or show a relative time until the first send.
  const lastAt =
    lastMessageAt instanceof Date
      ? lastMessageAt.toISOString()
      : typeof lastMessageAt === "string" && lastMessageAt
        ? lastMessageAt
        : "";
  return {
    id: row.id,
    title: row.title,
    provider: row.provider as AgentProvider,
    cwd: canonicalCwd(row.cwd),
    mode: row.mode as AgentMode,
    status: row.status as SessionStatus,
    acpSessionId: row.acpSessionId,
    themeId: row.themeId ?? null,
    sortOrder: row.sortOrder ?? 0,
    pinned: row.pinned ?? false,
    archived: row.archived ?? false,
    boardId: row.boardId ?? null,
    taskDescription: row.taskDescription ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    mcpDisabledIds: Array.isArray(row.mcpDisabledIds)
      ? (row.mcpDisabledIds as string[])
      : [],
    createdAt,
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: lastAt,
    usage: (row.usage as AcpUsage | null) ?? null,
    model: row.model || "",
    modelParams:
      row.modelParams && typeof row.modelParams === "object" && !Array.isArray(row.modelParams)
        ? (row.modelParams as Record<string, string>)
        : {},
  };
}

function mapPart(row: typeof messageParts.$inferSelect): MessagePartDto {
  return {
    id: row.id,
    messageId: row.messageId,
    type: row.type as MessagePartType,
    order: row.order,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadLastMessageAts(sessionIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (sessionIds.length === 0) return out;
  // Tree activity follows the last *user* prompt only — assistant stubs from
  // warm/turn start must not look like "used just now" after pin/rename/etc.
  const rows = await db
    .select({
      sessionId: messages.sessionId,
      lastAt: max(messages.createdAt),
    })
    .from(messages)
    .where(and(inArray(messages.sessionId, sessionIds), eq(messages.role, "user")))
    .groupBy(messages.sessionId);
  for (const row of rows) {
    if (row.lastAt) out.set(row.sessionId, row.lastAt);
  }
  return out;
}

async function withLastMessageAt(
  row: typeof sessions.$inferSelect,
): Promise<SessionDto> {
  const lastAts = await loadLastMessageAts([row.id]);
  return mapSession(row, lastAts.get(row.id) ?? null);
}

/** Sort + map a batch of session rows by activity, then board/sidebar order. */
async function mapSessionRows(rows: (typeof sessions.$inferSelect)[]): Promise<SessionDto[]> {
  const lastAts = await loadLastMessageAts(rows.map((r) => r.id));
  const mapped = rows.map((row) => mapSession(row, lastAts.get(row.id) ?? null));
  mapped.sort(
    (a, b) =>
      (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt) ||
      a.sortOrder - b.sortOrder,
  );
  return mapped;
}

/** Regular chats only — board tasks are partitioned out of the chat tree. */
export async function listSessions(): Promise<SessionDto[]> {
  return mapSessionRows(await db.select().from(sessions).where(isNull(sessions.boardId)));
}

/** Every session of one provider across every partition (chat tree, boards,
 *  archive) — the bulk chat export reads the whole population at once. */
export async function listSessionsByProvider(provider: string): Promise<SessionDto[]> {
  return mapSessionRows(await db.select().from(sessions).where(eq(sessions.provider, provider)));
}

/** Sessions by id across every partition (chat tree and boards) — for sweeps
 *  over live agent runtimes, which are not partitioned. */
export async function listSessionsByIds(ids: string[]): Promise<SessionDto[]> {
  if (!ids.length) return [];
  return mapSessionRows(await db.select().from(sessions).where(inArray(sessions.id, ids)));
}

/** Tasks of one board — the board page's session list, in the user's own order. */
export async function listBoardSessions(boardId: string): Promise<SessionDto[]> {
  return mapSessionRows(
    await db
      .select()
      .from(sessions)
      .where(eq(sessions.boardId, boardId))
      .orderBy(asc(sessions.sortOrder), asc(sessions.createdAt)),
  );
}

export async function getSessionDetail(id: string): Promise<SessionDetailDto | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!rows[0]) return null;
  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt));

  // One joined query for the whole chat. The per-message loop this replaces
  // cost a full message_parts scan per message (no covering index → ~40 s on
  // a long chat); grouping in memory keeps it a single round trip.
  const partRows = msgRows.length
    ? await db
        .select({ part: messageParts })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.messageId))
        .where(eq(messages.sessionId, id))
        .orderBy(asc(messages.createdAt), asc(messageParts.order), asc(messageParts.createdAt))
    : [];

  const partsByMessage = new Map<string, MessagePartDto[]>();
  for (const row of partRows) {
    const list = partsByMessage.get(row.part.messageId);
    const dto = mapPart(row.part);
    if (list) list.push(dto);
    else partsByMessage.set(row.part.messageId, [dto]);
  }

  const result: MessageDto[] = msgRows.map((msg) => ({
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role as MessageDto["role"],
    createdAt: msg.createdAt.toISOString(),
    parts: partsByMessage.get(msg.id) ?? [],
  }));

  const lastMessageAt =
    [...msgRows].reverse().find((m) => m.role === "user")?.createdAt ?? null;
  return { ...mapSession(rows[0], lastMessageAt), messages: result };
}

/**
 * Working directory of a session. Routes that only need the folder (every git
 * call does) must not go through `getSessionDetail`: that reads every message
 * and message part, which costs ~100 ms on a long chat.
 */
export async function getSessionCwd(id: string): Promise<string | null> {
  const rows = await db.select({ cwd: sessions.cwd }).from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ? canonicalCwd(rows[0].cwd) : null;
}

/**
 * Rewrite working directories stored in the pre-fix canonical form. A drive
 * root used to be written as the drive-relative `C:` (see `canonicalCwd`),
 * which no harness can start in — OMP answers `session/new` with an opaque
 * `-32603 Internal error` and the chat spins forever. Folder MCP overrides
 * hang off the same key, so chats and folders move together. Idempotent:
 * only values whose canonical form differs are touched.
 */
export async function repairStoredCwds(): Promise<string[]> {
  const stored = [
    ...(await db.selectDistinct({ cwd: sessions.cwd }).from(sessions)),
    ...(await db.select({ cwd: chatFolders.cwd }).from(chatFolders)),
    ...(await db.selectDistinct({ cwd: boardFolders.cwd }).from(boardFolders)),
  ];
  const stale = new Map<string, string>();
  for (const row of stored) {
    const next = canonicalCwd(row.cwd);
    if (next && next !== row.cwd) stale.set(row.cwd, next);
  }
  if (!stale.size) return [];

  for (const [from, to] of stale) {
    await db.update(sessions).set({ cwd: to }).where(eq(sessions.cwd, from));
    await db.update(boardFolders).set({ cwd: to }).where(eq(boardFolders.cwd, from));
    // chat_folders keys on cwd, and both spellings can be present at once.
    const [existing] = await db
      .select({ cwd: chatFolders.cwd })
      .from(chatFolders)
      .where(eq(chatFolders.cwd, to))
      .limit(1);
    if (existing) await db.delete(chatFolders).where(eq(chatFolders.cwd, from));
    else await db.update(chatFolders).set({ cwd: to }).where(eq(chatFolders.cwd, from));
  }
  return [...stale].map(([from, to]) => `${from} -> ${to}`);
}

export async function createSession(input: {
  /** Client-chosen id so an optimistic UI row keeps the server identity. */
  id?: string;
  title?: string;
  provider: AgentProvider;
  cwd: string;
  mode: AgentMode;
  themeId?: string | null;
  model?: string;
  modelParams?: Record<string, string>;
  acpSessionId?: string;
  /** Board partition — set only for tasks created from a board. */
  boardId?: string | null;
  /** Task description (card text / first-message prefill) for board tasks. */
  taskDescription?: string | null;
}): Promise<SessionDto> {
  const siblings = input.boardId
    ? await db.select().from(sessions).where(eq(sessions.boardId, input.boardId))
    : await db.select().from(sessions);
  const sortOrder = siblings.reduce((max, s) => Math.max(max, s.sortOrder ?? 0), -1) + 1;
  const settings = await getSettings();
  const cwd = canonicalCwd(input.cwd);
  // Pin the model this chat starts on. An empty `model` means "follow the
  // settings default", which silently follows every pick made in ANY chat: the
  // next message then boots a different model on the same ACP session, wiping
  // the prompt cache and (for some harnesses) the agent's context. Only an
  // explicit pick inside this chat may change it afterwards (setSessionModel).
  const pinnedModel =
    input.model?.trim() ||
    (input.provider === SHELL_SESSION_PROVIDER ? "" : modelForProvider(settings, input.provider));
  const pinnedParams =
    input.modelParams ??
    (pinnedModel ? modelParamsForProvider(settings, input.provider) : {});
  const defaultTitle =
    input.provider === SHELL_SESSION_PROVIDER
      ? path.basename(cwd) || defaultSessionTitle(settings.locale)
      : defaultSessionTitle(settings.locale);
  const [row] = await db
    .insert(sessions)
    .values({
      ...(input.id?.trim() ? { id: input.id.trim() } : {}),
      title: input.title ?? defaultTitle,
      provider: input.provider,
      cwd,
      mode: input.mode,
      status: "idle",
      themeId: input.themeId ?? null,
      sortOrder,
      ...(pinnedModel ? { model: pinnedModel } : {}),
      ...(Object.keys(pinnedParams).length ? { modelParams: pinnedParams } : {}),
      ...(input.acpSessionId?.trim() ? { acpSessionId: input.acpSessionId.trim() } : {}),
      ...(input.boardId ? { boardId: input.boardId } : {}),
      ...(input.taskDescription != null ? { taskDescription: input.taskDescription } : {}),
    })
    .returning();
  // Keep the folder alive after the last chat in it is deleted. Board tasks
  // never seed the sidebar's folder list — their projects live on the board.
  if (row.cwd && !input.boardId) await rememberFolders([row.cwd]);
  return mapSession(row);
}

export async function updateSession(
  id: string,
  patch: Partial<{
    title: string;
    status: SessionStatus;
    acpSessionId: string | null;
    mode: AgentMode;
    cwd: string;
    provider: AgentProvider;
    themeId: string | null;
    sortOrder: number;
    pinned: boolean;
    archived: boolean;
    mcpDisabledIds: string[];
    model?: string;
    modelParams?: Record<string, string>;
    taskDescription?: string | null;
    doneAt?: Date | null;
  }>,
): Promise<SessionDto | null> {
  if (patch.cwd !== undefined) patch.cwd = canonicalCwd(patch.cwd);
  const [row] = await db
    .update(sessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sessions.id, id))
    .returning();
  if (!row) return null;
  const dto = await withLastMessageAt(row);
  broadcastToSession(id, { type: "session.updated", sessionId: id, session: dto });
  return dto;
}
/**
 * Stamp the first turn start of a board task — the Todo ⇄ Wait split marker.
 * Idempotent: only fires while the task has never started.
 */
export async function markBoardTaskStarted(id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ startedAt: new Date() })
    .where(and(eq(sessions.id, id), isNotNull(sessions.boardId), isNull(sessions.startedAt)));
}

export async function saveSessionUsage(id: string, usage: AcpUsage | null): Promise<void> {
  await db
    .update(sessions)
    .set({ usage, updatedAt: new Date() })
    .where(eq(sessions.id, id));
}


export async function reorderSessions(
  items: Array<{ id: string; themeId: string | null; sortOrder: number }>,
): Promise<SessionDto[]> {
  for (const item of items) {
    await db
      .update(sessions)
      .set({
        themeId: item.themeId,
        sortOrder: item.sortOrder,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, item.id));
  }
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return [];
  return mapSessionRows(await db.select().from(sessions).where(inArray(sessions.id, ids)));
}

export async function deleteSession(id: string): Promise<boolean> {
  const rows = await db.delete(sessions).where(eq(sessions.id, id)).returning();
  return rows.length > 0;
}

export async function createMessage(
  sessionId: string,
  role: MessageDto["role"],
): Promise<MessageDto> {
  const [row] = await db
    .insert(messages)
    .values({ sessionId, role })
    .returning();
  const dto: MessageDto = {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as MessageDto["role"],
    createdAt: row.createdAt.toISOString(),
    parts: [],
  };
  broadcastToSession(sessionId, { type: "message.created", sessionId, message: dto });
  // Touch updatedAt for bookkeeping, but do NOT broadcast session.updated —
  // that frame still carries the pre-turn status (idle) and made clients flash
  // the thinking header off/on when createMessage raced ahead of status=running.
  await db
    .update(sessions)
    .set({ updatedAt: row.createdAt })
    .where(eq(sessions.id, sessionId));
  return dto;
}

export async function appendPart(
  sessionId: string,
  messageId: string,
  type: MessagePartType,
  payload: Record<string, unknown>,
  order?: number,
): Promise<MessagePartDto> {
  const existing = await db
    .select({ order: messageParts.order })
    .from(messageParts)
    .where(eq(messageParts.messageId, messageId))
    .orderBy(desc(messageParts.order))
    .limit(1);
  const nextOrder = order ?? (existing[0]?.order ?? -1) + 1;
  const [row] = await db
    .insert(messageParts)
    .values({ messageId, type, payload, order: nextOrder })
    .returning();
  const part = mapPart(row);
  broadcastToSession(sessionId, {
    type: "part.appended",
    sessionId,
    messageId,
    part,
  });
  return part;
}

export async function updatePart(
  sessionId: string,
  partId: string,
  payload: Record<string, unknown>,
  type?: MessagePartType,
): Promise<MessagePartDto | null> {
  const existing = await db.select().from(messageParts).where(eq(messageParts.id, partId)).limit(1);
  if (!existing[0]) return null;
  const prev =
    existing[0].payload && typeof existing[0].payload === "object" && !Array.isArray(existing[0].payload)
      ? (existing[0].payload as Record<string, unknown>)
      : {};
  const [row] = await db
    .update(messageParts)
    .set({
      payload: { ...prev, ...payload },
      ...(type ? { type } : {}),
    })
    .where(eq(messageParts.id, partId))
    .returning();
  if (!row) return null;
  const part = mapPart(row);
  broadcastToSession(sessionId, {
    type: "part.updated",
    sessionId,
    messageId: row.messageId,
    part,
  });
  return part;
}

/** Current payload of a message part, or null if missing. */
export async function getPartPayload(partId: string): Promise<Record<string, unknown> | null> {
  const existing = await db.select().from(messageParts).where(eq(messageParts.id, partId)).limit(1);
  if (!existing[0]) return null;
  const payload = existing[0].payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

function appendStreamText(prev: string, next: string): string {
  // Stream deltas already include their own spaces — never invent ones between
  // letters or subword tokens, or words get split like "Ex ce llen t".
  return prev + next;
}

/** `text` field of a part payload, validated at read time. */
function payloadText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("text" in payload)) return "";
  const text = payload.text;
  return typeof text === "string" ? text : "";
}

/**
 * Replayed or resumed turns re-emit an already-streamed thought verbatim
 * (full text after streamed chunks, or a fresh part in a sibling message).
 * Such re-emissions are long; short repeats can be legitimate thinking.
 */
const THOUGHT_DEDUPE_MIN_CHARS = 40;

/** Last stored thought part of the session (any message), with its timing. */
async function lastThoughtPartOfSession(
  sessionId: string,
): Promise<{ id: string; messageId: string; createdAt: Date; text: string } | null> {
  const rows = await db
    .select({
      id: messageParts.id,
      messageId: messageParts.messageId,
      createdAt: messages.createdAt,
      text: sql<string>`json_extract(${messageParts.payload}, '$.text')`,
    })
    .from(messageParts)
    .innerJoin(messages, eq(messages.id, messageParts.messageId))
    .where(and(eq(messages.sessionId, sessionId), eq(messageParts.type, "thought")))
    .orderBy(desc(messages.createdAt), desc(messageParts.order))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, messageId: row.messageId, createdAt: row.createdAt, text: row.text ?? "" };
}

/** True when a user message sits strictly between `after` and `beforeOrAt`. */
async function userMessageBetween(sessionId: string, after: Date, beforeOrAt: Date): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, "user"),
        gt(messages.createdAt, after),
        lte(messages.createdAt, beforeOrAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function appendTextChunk(
  sessionId: string,
  messageId: string,
  type: "text" | "thought",
  text: string,
  openPartId?: string | null,
): Promise<string> {
  if (!text) {
    return openPartId ?? (await appendPart(sessionId, messageId, type, { text: "" })).id;
  }
  if (openPartId) {
    const rows = await db.select().from(messageParts).where(eq(messageParts.id, openPartId)).limit(1);
    if (rows[0] && rows[0].type === type && rows[0].messageId === messageId) {
      const prev = payloadText(rows[0].payload);
      // Full-text re-emission of an already-streamed thought (agent resumes
      // reasoning after tools, replay) must not double the block.
      if (
        type === "thought" &&
        text.trim().length >= THOUGHT_DEDUPE_MIN_CHARS &&
        prev.trimEnd().endsWith(text.trim())
      ) {
        return openPartId;
      }
      await updatePart(sessionId, openPartId, { text: appendStreamText(prev, text) });
      return openPartId;
    }
  }
  // New thought part: drop it when the exact same thought was just stored in
  // this turn (same message, or the previous assistant message with no user
  // input in between) — a resumed/replayed turn must not duplicate it.
  if (type === "thought" && text.trim().length >= THOUGHT_DEDUPE_MIN_CHARS) {
    const last = await lastThoughtPartOfSession(sessionId);
    if (last && last.text.trim() === text.trim()) {
      const sameTurn =
        last.messageId === messageId ||
        !(await userMessageBetween(sessionId, last.createdAt, await messageCreatedAt(messageId)));
      if (sameTurn) {
        // Anchor the turn's thought slot to this message so later genuine
        // chunks land here; the duplicate content itself is dropped.
        const anchor = await appendPart(sessionId, messageId, type, { text: "" });
        return anchor.id;
      }
    }
  }
  const part = await appendPart(sessionId, messageId, type, { text });
  return part.id;
}

async function messageCreatedAt(messageId: string): Promise<Date> {
  const rows = await db.select({ createdAt: messages.createdAt }).from(messages).where(eq(messages.id, messageId)).limit(1);
  return rows[0]?.createdAt ?? new Date(0);
}

/** Keep `messageId`, delete every later message in the session (cascade parts). */
export async function truncateMessagesAfter(
  sessionId: string,
  messageId: string,
): Promise<MessageDto[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));
  const idx = rows.findIndex((m) => m.id === messageId);
  if (idx < 0) throw Object.assign(new Error("Message not found"), { statusCode: 404 });
  const toDelete = rows.slice(idx + 1);
  for (const row of toDelete) {
    await db.delete(messages).where(eq(messages.id, row.id));
  }
  const detail = await getSessionDetail(sessionId);
  const next = detail?.messages ?? [];
  broadcastToSession(sessionId, { type: "messages.replaced", sessionId, messages: next });
  if (detail) {
    const { messages: _msgs, slashCommands: _cmds, ...session } = detail;
    broadcastToSession(sessionId, { type: "session.updated", sessionId, session });
  }
  return next;
}

export async function replaceUserMessageText(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<MessageDto> {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!rows[0] || rows[0].sessionId !== sessionId || rows[0].role !== "user") {
    throw Object.assign(new Error("User message not found"), { statusCode: 404 });
  }
  await db.delete(messageParts).where(eq(messageParts.messageId, messageId));
  const trimmed = text.trim();
  const slashMatch = trimmed.match(/^\/([a-z][\w-]*(?::[a-z][\w-]*)?)/i);
  await appendPart(sessionId, messageId, "text", {
    text,
    ...(slashMatch ? { isSlashCommand: true, commandName: slashMatch[1] } : {}),
  });
  const detail = await getSessionDetail(sessionId);
  const updated = detail?.messages.find((m) => m.id === messageId);
  if (!updated) throw Object.assign(new Error("User message not found"), { statusCode: 404 });
  broadcastToSession(sessionId, { type: "messages.replaced", sessionId, messages: detail!.messages });
  if (detail) {
    const { messages: _msgs, slashCommands: _cmds, ...session } = detail;
    broadcastToSession(sessionId, { type: "session.updated", sessionId, session });
  }
  return updated;
}

const STUCK_TOOL_STATUSES = new Set(["pending", "in_progress", "running"]);

const INTERRUPT_NOTE =
  "Сервер был перезапущен — этот ход прерван. Отправьте сообщение ещё раз.";

/**
 * Pin the resolved model on chats created before creation-time pinning: they
 * still carry an empty `model` and follow the global settings default, so a
 * pick made in another chat would switch them mid-conversation. Pinning uses
 * the value each chat resolves to right now, so the next message is unchanged.
 * One-shot per chat: a non-empty `model` is never touched again.
 */
export async function pinResolvedSessionModels(): Promise<number> {
  const settings = await getSettings();
  const rows = await db.select().from(sessions);
  let pinned = 0;
  for (const row of rows) {
    if (row.model || row.provider === SHELL_SESSION_PROVIDER) continue;
    const provider = row.provider as AgentProvider;
    const model = modelForProvider(settings, provider);
    if (!model) continue;
    const params = modelParamsForProvider(settings, provider);
    await updateSession(row.id, {
      model,
      ...(Object.keys(params).length ? { modelParams: params } : {}),
    });
    pinned++;
  }
  return pinned;
}

/**
 * After a server restart no ACP runtime survives. Two stale things remain in
 * the DB and would lock the UI forever:
 *  - sessions left in "running"/"waiting" (composer blocked);
 *  - tool_call parts with a non-terminal status (spinner + "выполняется…").
 * Reset both, and leave a visible note in the last assistant message.
 * Safe to call at boot: the runtime map is empty, so every such part/session
 * is stale by definition.
 */
export async function reconcileStaleSessions(): Promise<{
  sessions: number;
  parts: number;
}> {
  const stale = await db
    .select()
    .from(sessions)
    .where(or(eq(sessions.status, "running"), eq(sessions.status, "waiting")));
  let fixedSessions = 0;
  let fixedParts = 0;

  // A session parked on an unanswered question is NOT stale: the agent asked
  // and is waiting for the human, and the question part is the durable,
  // answerable state (answering it after this restart re-drives the turn).
  // Only a turn that would spin forever without its runtime is reset.
  const parkedOnQuestion = new Set<string>();
  if (stale.length) {
    const questionParts = await db
      .select({ sessionId: messages.sessionId, payload: messageParts.payload })
      .from(messageParts)
      .innerJoin(messages, eq(messageParts.messageId, messages.id))
      .where(eq(messageParts.type, "question"));
    for (const row of questionParts) {
      const payload = row.payload as { pending?: unknown } | null;
      if (payload?.pending === true) parkedOnQuestion.add(row.sessionId);
    }
  }

  for (const row of stale) {
    if (parkedOnQuestion.has(row.id)) continue;
    await updateSession(row.id, { status: "idle" });
    fixedSessions++;
  }

  // Flip stuck tool parts in every session (idle ones included — warm-up can
  // mask the session status while the part keeps spinning).
  const allParts = await db
    .select({ part: messageParts, sessionId: messages.sessionId })
    .from(messageParts)
    .innerJoin(messages, eq(messageParts.messageId, messages.id));
  const touchedSessions = new Set<string>();
  for (const { part: p, sessionId } of allParts) {
    const payload = p.payload as { status?: unknown } | null;
    const status = payload ? String(payload.status ?? "") : "";
    if (p.type === "tool_call" && STUCK_TOOL_STATUSES.has(status)) {
      await updatePart(sessionId, p.id, { status: "error", interrupted: true });
      fixedParts++;
      touchedSessions.add(sessionId);
    }
  }

  // One explanatory note per touched session (idempotent across restarts).
  for (const sessionId of touchedSessions) {
    const alreadyNoted = await db
      .select({ id: messageParts.id })
      .from(messageParts)
      .innerJoin(messages, eq(messageParts.messageId, messages.id))
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messageParts.type, "error"),
          // `json_extract` yields TEXT; comparing it to the boolean bind never matched,
          // so every restart appended another identical interrupt note.
          eq(sql`json_extract(${messageParts.payload}, '$.interrupted')`, sql`'true'`),
        ),
      )
      .limit(1);
    if (alreadyNoted[0]) continue;
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt));
    const lastAssistant = rows.filter((m) => m.role === "assistant").at(-1);
    if (lastAssistant) {
      await appendPart(sessionId, lastAssistant.id, "error", {
        message: INTERRUPT_NOTE,
        interrupted: true,
      });
    }
  }

  return { sessions: fixedSessions, parts: fixedParts };
}
