import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BoardDto } from "@acpio/shared";
import { db } from "../db/client.js";
import { boardFolders, boards, sessions } from "../db/schema.js";
import { listFolders } from "./folders.js";
import { canonicalCwd } from "@acpio/shared";

/** Attach each board row's folders (ordered) — one query for all of them. */
async function withFolders(boardRows: (typeof boards.$inferSelect)[]): Promise<BoardDto[]> {
  const ids = boardRows.map((r) => r.id);
  const folderRows = ids.length
    ? await db
        .select()
        .from(boardFolders)
        .where(inArray(boardFolders.boardId, ids))
        .orderBy(asc(boardFolders.sortOrder), asc(boardFolders.id))
    : [];
  const byBoard = new Map<string, string[]>();
  for (const row of folderRows) {
    const list = byBoard.get(row.boardId) ?? [];
    list.push(row.cwd);
    byBoard.set(row.boardId, list);
  }
  return boardRows.map((row) => ({
    id: row.id,
    name: row.name,
    folders: byBoard.get(row.id) ?? [],
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listBoards(): Promise<BoardDto[]> {
  const rows = await db
    .select()
    .from(boards)
    .orderBy(asc(boards.sortOrder), asc(boards.createdAt));
  return withFolders(rows);
}

export async function getBoard(id: string): Promise<BoardDto | null> {
  const rows = await db.select().from(boards).where(eq(boards.id, id)).limit(1);
  if (!rows[0]) return null;
  return (await withFolders(rows))[0] ?? null;
}

export async function createBoard(name: string): Promise<BoardDto> {
  // A board's sortOrder is its slot in the sidebar tree, where folders and
  // boards share one sequence — a new board goes to the bottom.
  const [{ n: boardCount }] = await db.select({ n: sql<number>`count(*)` }).from(boards);
  const sortOrder = (await listFolders()).length + Number(boardCount);
  const [row] = await db
    .insert(boards)
    .values({ name: name.trim(), sortOrder })
    .returning();
  return { id: row.id, name: row.name, folders: [], sortOrder: row.sortOrder, createdAt: row.createdAt.toISOString() };
}

export async function updateBoard(
  id: string,
  patch: { name?: string; sortOrder?: number },
): Promise<BoardDto | null> {
  const [row] = await db
    .update(boards)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    })
    .where(eq(boards.id, id))
    .returning();
  if (!row) return null;
  return (await withFolders([row]))[0] ?? null;
}

/** Delete the board (folders cascade). Sessions are deleted by the route. */
export async function deleteBoard(id: string): Promise<boolean> {
  const rows = await db.delete(boards).where(eq(boards.id, id)).returning();
  return rows.length > 0;
}

/** Delete every task of the board (messages cascade with the row). */
export async function deleteBoardSessions(boardId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.boardId, boardId));
}

/** Replace the board's folders; list order is the display/group order. */
export async function setBoardFolders(boardId: string, cwds: string[]): Promise<string[] | null> {
  const exists = await db.select({ id: boards.id }).from(boards).where(eq(boards.id, boardId)).limit(1);
  if (!exists[0]) return null;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of cwds) {
    const cwd = canonicalCwd(raw);
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    ordered.push(cwd);
  }
  await db.delete(boardFolders).where(eq(boardFolders.boardId, boardId));
  let order = 0;
  for (const cwd of ordered) {
    await db.insert(boardFolders).values({ boardId, cwd, sortOrder: order++ });
  }
  return ordered;
}

/** True when the board exists and the cwd is one of its configured folders. */
export async function boardAcceptsCwd(boardId: string, cwd: string): Promise<boolean> {
  const key = canonicalCwd(cwd);
  if (!key) return false;
  const rows = await db
    .select({ cwd: boardFolders.cwd })
    .from(boardFolders)
    .where(and(eq(boardFolders.boardId, boardId), eq(boardFolders.cwd, key)))
    .limit(1);
  return rows.length > 0;
}
