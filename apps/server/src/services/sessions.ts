import { asc, desc, eq } from "drizzle-orm";
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
import { db } from "../db/client.js";
import { messageParts, messages, sessions } from "../db/schema.js";
import { broadcastToSession } from "./wsHub.js";

function mapSession(row: typeof sessions.$inferSelect): SessionDto {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

export async function listSessions(): Promise<SessionDto[]> {
  const rows = await db
    .select()
    .from(sessions)
    .orderBy(asc(sessions.sortOrder), desc(sessions.updatedAt));
  return rows.map(mapSession);
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

  return { ...mapSession(rows[0]), messages: result };
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
  const [row] = await db
    .insert(sessions)
    .values({
      title: input.title ?? "Новый чат",
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
  }>,
): Promise<SessionDto | null> {
  const [row] = await db
    .update(sessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sessions.id, id))
    .returning();
  if (!row) return null;
  const dto = mapSession(row);
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
  await db.update(sessions).set({ updatedAt: new Date() }).where(eq(sessions.id, sessionId));
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
  // letter chunks or subword tokens turn into "От ли чно".
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
