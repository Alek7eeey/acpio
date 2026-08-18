import { desc, eq, sql } from "drizzle-orm";
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
 * SQLite's LIKE (and lower()) only folds ASCII, so case-insensitive matching
 * for Cyrillic is done in JS over the text parts, ordered by message recency
 * so the freshest hits come first. Fine at this scale (local single-user).
 */
export async function searchMessages(raw: string, limit = 50): Promise<MessageSearchHit[]> {
  const needle = raw.trim();
  if (!needle) return [];
  const needleLower = needle.toLowerCase();

  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      messageId: messages.id,
      partId: messageParts.id,
      role: messages.role,
      createdAt: messageParts.createdAt,
      text: sql<string>`json_extract(${messageParts.payload}, '$.text')`,
    })
    .from(messageParts)
    .innerJoin(messages, eq(messageParts.messageId, messages.id))
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(eq(messageParts.type, "text"))
    .orderBy(desc(messages.createdAt));

  return rows
    .filter((r) => (r.text ?? "").toLowerCase().includes(needleLower))
    .slice(0, limit)
    .map((r) => ({
      sessionId: r.sessionId,
      sessionTitle: r.sessionTitle,
      messageId: r.messageId,
      partId: r.partId,
      role: r.role,
      snippet: buildSnippet(r.text ?? "", needle),
      createdAt: r.createdAt.toISOString(),
    }));
}
