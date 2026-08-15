import { and, asc, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import type {
  MessageDto,
  MessagePartDto,
  MessagePartType,
  SessionDetailDto,
  SessionDto,
  AgentMode,
  AgentProvider,
  SessionStatus,
} from "@acprocess/shared";
import { defaultSessionTitle } from "@acprocess/i18n";
import { db } from "../db/client.js";
import { messageParts, messages, sessions } from "../db/schema.js";
import { broadcastToSession } from "./wsHub.js";
import { getSettings } from "./settings.js";

function mapSession(
  row: typeof sessions.$inferSelect,
  lastMessageAt?: Date | string | null,
): SessionDto {
  const createdAt = row.createdAt.toISOString();
  const lastAt =
    lastMessageAt instanceof Date
      ? lastMessageAt.toISOString()
      : typeof lastMessageAt === "string" && lastMessageAt
        ? lastMessageAt
        : createdAt;
  return {
    id: row.id,
    title: row.title,
    provider: row.provider as AgentProvider,
    cwd: row.cwd,
    mode: row.mode as AgentMode,
    status: row.status as SessionStatus,
    acpSessionId: row.acpSessionId,
    themeId: row.themeId ?? null,
    sortOrder: row.sortOrder ?? 0,
    pinned: row.pinned ?? false,
    archived: row.archived ?? false,
    createdAt,
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: lastAt,
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
  const rows = await db
    .select({
      sessionId: messages.sessionId,
      lastAt: max(messages.createdAt),
    })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
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

export async function listSessions(): Promise<SessionDto[]> {
  const rows = await db.select().from(sessions);
  const lastAts = await loadLastMessageAts(rows.map((r) => r.id));
  const mapped = rows.map((row) => mapSession(row, lastAts.get(row.id) ?? null));
  mapped.sort(
    (a, b) =>
      b.lastMessageAt.localeCompare(a.lastMessageAt) || a.sortOrder - b.sortOrder,
  );
  return mapped;
}

export async function getSessionDetail(id: string): Promise<SessionDetailDto | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!rows[0]) return null;
  const msgRows = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.createdAt));

  const result: MessageDto[] = [];
  for (const msg of msgRows) {
    const parts = await db
      .select()
      .from(messageParts)
      .where(eq(messageParts.messageId, msg.id))
      .orderBy(asc(messageParts.order), asc(messageParts.createdAt));
    result.push({
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role as MessageDto["role"],
      createdAt: msg.createdAt.toISOString(),
      parts: parts.map(mapPart),
    });
  }

  const lastMessageAt = msgRows.at(-1)?.createdAt ?? null;
  return { ...mapSession(rows[0], lastMessageAt), messages: result };
}

export async function createSession(input: {
  title?: string;
  provider: AgentProvider;
  cwd: string;
  mode: AgentMode;
  themeId?: string | null;
}): Promise<SessionDto> {
  const siblings = await db.select().from(sessions);
  const sortOrder = siblings.reduce((max, s) => Math.max(max, s.sortOrder ?? 0), -1) + 1;
  const settings = await getSettings();
  const [row] = await db
    .insert(sessions)
    .values({
      title: input.title ?? defaultSessionTitle(settings.locale),
      provider: input.provider,
      cwd: input.cwd,
      mode: input.mode,
      status: "idle",
      themeId: input.themeId ?? null,
      sortOrder,
    })
    .returning();
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
  }>,
): Promise<SessionDto | null> {
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
  return listSessions();
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
  const [sessionRow] = await db
    .update(sessions)
    .set({ updatedAt: row.createdAt })
    .where(eq(sessions.id, sessionId))
    .returning();
  if (sessionRow) {
    const sessionDto = mapSession(sessionRow, row.createdAt);
    broadcastToSession(sessionId, {
      type: "session.updated",
      sessionId,
      session: sessionDto,
    });
  }
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

function appendStreamText(prev: string, next: string): string {
  // Stream deltas already include their own spaces — never invent ones between
  // letters or subword tokens, or words get split like "Ex ce llen t".
  return prev + next;
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
      const prev = (rows[0].payload as { text?: string })?.text ?? "";
      await updatePart(sessionId, openPartId, { text: appendStreamText(prev, text) });
      return openPartId;
    }
  }
  const part = await appendPart(sessionId, messageId, type, { text });
  return part.id;
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

  for (const row of stale) {
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
          eq(sql`(${messageParts.payload}->>'interrupted')`, "true"),
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
