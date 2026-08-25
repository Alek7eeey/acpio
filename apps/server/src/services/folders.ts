import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { chatFolders, sessions } from "../db/schema.js";
import { normalizeCwd } from "./sessions.js";

/**
 * Folders that have ever held chats: persisted rows plus every cwd currently
 * in use by a session (so existing chats always appear even if their folder
 * row was removed).
 */
export async function listFolders(): Promise<string[]> {
  const remembered = await db.select({ cwd: chatFolders.cwd }).from(chatFolders);
  const used = await db
    .selectDistinct({ cwd: sessions.cwd })
    .from(sessions)
    .where(ne(sessions.cwd, ""));
  const seen = new Set<string>();
  for (const row of [...remembered, ...used]) {
    if (row.cwd) seen.add(row.cwd);
  }
  return [...seen];
}

/** Record folders (used by the web to seed/migrate locally known ones). */
export async function rememberFolders(cwds: string[]): Promise<void> {
  for (const raw of cwds) {
    const cwd = normalizeCwd(raw);
    if (!cwd) continue;
    await db
      .insert(chatFolders)
      .values({ cwd })
      .onConflictDoNothing({ target: chatFolders.cwd });
  }
}

/**
 * Forget a folder and delete the active chats inside it (messages cascade).
 * Archived chats are NOT deleted — archiving is a separate, reversible
 * decision, and a folder whose chats all sit in the archive must not lose
 * them when its empty shell is removed.
 */
export async function deleteFolder(cwd: string): Promise<boolean> {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return false;
  await db
    .delete(sessions)
    .where(and(eq(sessions.cwd, normalized), eq(sessions.archived, false)));
  const rows = await db
    .delete(chatFolders)
    .where(eq(chatFolders.cwd, normalized))
    .returning();
  return rows.length > 0;
}
