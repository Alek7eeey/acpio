import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageParts, messages, sessions } from "../db/schema.js";

export type MessageSearchHit = {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  partId: string;
  /** Role of the message the part belongs to ("user" | "assistant" | …). */
  role: string;
  /** Text around the first match, ellipsized. */
  snippet: string;
  createdAt: string;
};

/** ~36 chars before, ~72 after the first match. */
function buildSnippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text.slice(0, 108);
  const start = Math.max(0, idx - 36);
  const end = Math.min(text.length, idx + needle.length + 72);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Full-text search over every session's text parts (user + assistant).
 * Postgres ILIKE with escaped % / _ / \ — fine at this scale; ordered by
 * message recency so the freshest hits come first.
 */
export async function searchMessages(raw: string, limit = 50): Promise<MessageSearchHit[]> {
  const needle = raw.trim();
  if (!needle) return [];
  const escaped = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${escaped}%`;

  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      messageId: messages.id,
      partId: messageParts.id,
      role: messages.role,
      createdAt: messageParts.createdAt,
      text: sql<string>`${messageParts.payload}->>'text'`,
    })
    .from(messageParts)
    .innerJoin(messages, eq(messageParts.messageId, messages.id))
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messageParts.type, "text"),
        sql`${messageParts.payload}->>'text' ILIKE ${like} ESCAPE '\\'`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    sessionTitle: r.sessionTitle,
    messageId: r.messageId,
    partId: r.partId,
    role: r.role,
    snippet: buildSnippet(r.text ?? "", needle),
    createdAt: r.createdAt.toISOString(),
  }));
}
