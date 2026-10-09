import { and, eq, isNull, ne, asc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { chatFolders, sessions } from "../db/schema.js";
import { canonicalCwd } from "@acpio/shared";

/**
 * Folders that have ever held chats: persisted rows plus every cwd currently
 * in use by a session (so existing chats always appear even if their folder
 * row was removed).
 */
export async function listFolders(): Promise<string[]> {
  const remembered = await db
    .select({ cwd: chatFolders.cwd })
    .from(chatFolders)
    .orderBy(asc(chatFolders.sortOrder), asc(chatFolders.createdAt));
  const used = await db
    .selectDistinct({ cwd: sessions.cwd })
    .from(sessions)
    .where(and(ne(sessions.cwd, ""), isNull(sessions.boardId)));
  const seen = new Set<string>();
  const orderedList: string[] = [];

  for (const row of remembered) {
    if (row.cwd && !seen.has(row.cwd)) {
      seen.add(row.cwd);
      orderedList.push(row.cwd);
    }
  }

  for (const row of used) {
    if (row.cwd && !seen.has(row.cwd)) {
      seen.add(row.cwd);
      orderedList.push(row.cwd);
    }
  }

  return orderedList;
}

/** Record folders (used by the web to seed/migrate locally known ones). */
export async function rememberFolders(cwds: string[]): Promise<void> {
  for (const raw of cwds) {
    const cwd = canonicalCwd(raw);
    if (!cwd) continue;

    // Check if already exists first
    const [existing] = await db
      .select({ cwd: chatFolders.cwd })
      .from(chatFolders)
      .where(eq(chatFolders.cwd, cwd))
      .limit(1);
    if (existing) continue;

    // Get max sort_order
    const [maxRow] = await db
      .select({ maxOrder: sql<number>`max(${chatFolders.sortOrder})` })
      .from(chatFolders);
    const nextOrder = (maxRow?.maxOrder ?? 0) + 1;

    await db
      .insert(chatFolders)
      .values({ cwd, sortOrder: nextOrder })
      .onConflictDoNothing({ target: chatFolders.cwd });
  }
}

/** Reorder folders by updating their sort_order. */
export async function reorderFolders(
  items: Array<{ cwd: string; sortOrder: number }>,
): Promise<string[]> {
  for (const item of items) {
    const normalized = canonicalCwd(item.cwd);
    if (!normalized) continue;
    await db
      .update(chatFolders)
      .set({
        sortOrder: item.sortOrder,
      })
      .where(eq(chatFolders.cwd, normalized));
  }
  return listFolders();
}

/**
 * Forget a folder and delete the active chats inside it (messages cascade).
 * Archived chats are NOT deleted — archiving is a separate, reversible
 * decision, and a folder whose chats all sit in the archive must not lose
 * them when its empty shell is removed.
 */
export async function deleteFolder(cwd: string): Promise<boolean> {
  const normalized = canonicalCwd(cwd);
  if (!normalized) return false;
  await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.cwd, normalized),
        eq(sessions.archived, false),
        // Board tasks belong to their board, not to the sidebar folder.
        isNull(sessions.boardId),
      ),
    );
  const rows = await db
    .delete(chatFolders)
    .where(eq(chatFolders.cwd, normalized))
    .returning();
  return rows.length > 0;
}
