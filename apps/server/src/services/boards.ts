import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BoardColumnDto, BoardDto } from "@acpio/shared";
import { db } from "../db/client.js";
import { boardColumns, boardFolders, boards, sessions } from "../db/schema.js";
import { listFolders } from "./folders.js";
import { canonicalCwd, defaultBoardColumns } from "@acpio/shared";

type BoardColumnRow = typeof boardColumns.$inferSelect;

/** One stored column as the board hands it to the client. */
function mapColumn(row: BoardColumnRow): BoardColumnDto {
  // A row from before a lane was only a lane carried `kind: "auto"` and a rule.
  // Nothing claims cards by a condition now, so it reads as what it can be: a
  // lane the reader fills by hand — its title stays, its cards go to the homes.
  const home = row.home;
  return {
    id: row.id,
    title: row.title ?? "",
    kind: home ? "stage" : "manual",
    anchor: home ? ((row.anchor as BoardColumnDto["anchor"]) ?? null) : null,
    home,
    sortOrder: row.sortOrder ?? 0,
    sortMode: row.sortMode as BoardColumnDto["sortMode"],
    acceptsPrompt: row.acceptsPrompt,
    keepOnRun: row.keepOnRun,
  };
}

/**
 * Give a board its four stage homes. A board made before columns existed (or
 * one read straight after the upgrade) carries none; seeding on read keeps the
 * board exactly as it was — the homes carry today's behavior — without a
 * migration that has to know about every board file. Idempotent: the insert
 * yields to a row that is already there.
 */
export async function ensureBoardColumns(boardId: string): Promise<void> {
  const rows = await db
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .limit(1);
  if (rows[0]) return;
  await db
    .insert(boardColumns)
    .values(
      defaultBoardColumns().map((column) => ({
        id: column.id,
        boardId,
        title: column.title,
        kind: column.kind,
        anchor: column.anchor,
        home: column.home,
        sortOrder: column.sortOrder,
        sortMode: column.sortMode,
        acceptsPrompt: column.acceptsPrompt,
        keepOnRun: column.keepOnRun,
      })),
    )
    .onConflictDoNothing();
}

/** Seed every board of the list that carries no columns yet — one query to find them. */
async function ensureColumnsFor(boardRows: (typeof boards.$inferSelect)[]) {
  const ids = boardRows.map((r) => r.id);
  if (!ids.length) return;
  const seeded = new Set(
    (
      await db
        .select({ boardId: boardColumns.boardId })
        .from(boardColumns)
        .where(inArray(boardColumns.boardId, ids))
        .groupBy(boardColumns.boardId)
    ).map((row) => row.boardId),
  );
  for (const id of ids) {
    if (!seeded.has(id)) await ensureBoardColumns(id);
  }
}

/** Attach each board row's folders and columns (ordered) — one query each. */
async function withFolders(boardRows: (typeof boards.$inferSelect)[]): Promise<BoardDto[]> {
  const ids = boardRows.map((r) => r.id);
  await ensureColumnsFor(boardRows);
  const columnRows = ids.length
    ? await db
        .select()
        .from(boardColumns)
        .where(inArray(boardColumns.boardId, ids))
        .orderBy(asc(boardColumns.sortOrder), asc(boardColumns.createdAt))
    : [];
  const columnsByBoard = new Map<string, BoardColumnDto[]>();
  for (const row of columnRows) {
    const list = columnsByBoard.get(row.boardId) ?? [];
    list.push(mapColumn(row));
    columnsByBoard.set(row.boardId, list);
  }
  const folderRows = ids.length
    ? await db
        .select()
        .from(boardFolders)
        .where(inArray(boardFolders.boardId, ids))
        .orderBy(asc(boardFolders.sortOrder), asc(boardFolders.id))
    : [];
  const byBoard = new Map<string, string[]>();
  const tagsByBoard = new Map<string, Record<string, string>>();
  const autoRunByBoard = new Map<string, Record<string, boolean>>();
  for (const row of folderRows) {
    const list = byBoard.get(row.boardId) ?? [];
    list.push(row.cwd);
    byBoard.set(row.boardId, list);
    if (row.tag) {
      const tags = tagsByBoard.get(row.boardId) ?? {};
      tags[row.cwd] = row.tag;
      tagsByBoard.set(row.boardId, tags);
    }
    if (row.autoRun) {
      const autoRun = autoRunByBoard.get(row.boardId) ?? {};
      autoRun[row.cwd] = true;
      autoRunByBoard.set(row.boardId, autoRun);
    }
  }
  return boardRows.map((row) => ({
    id: row.id,
    name: row.name,
    folders: byBoard.get(row.id) ?? [],
    folderTags: tagsByBoard.get(row.id) ?? {},
    folderAutoRun: autoRunByBoard.get(row.id) ?? {},
    columns: columnsByBoard.get(row.id) ?? defaultBoardColumns(),
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
  // A new board opens on the four stage homes, exactly like an old one.
  await ensureBoardColumns(row.id);
  return {
    id: row.id,
    name: row.name,
    folders: [],
    folderTags: {},
    folderAutoRun: {},
    columns: defaultBoardColumns(),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
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
  // The rows are replaced wholesale to renumber the order, so their tags and
  // queue switches are carried over by hand — otherwise every add, remove and
  // reorder wipes them.
  const kept = new Map(
    (
      await db
        .select({ cwd: boardFolders.cwd, tag: boardFolders.tag, autoRun: boardFolders.autoRun })
        .from(boardFolders)
        .where(eq(boardFolders.boardId, boardId))
    ).map((row) => [row.cwd, row]),
  );
  await db.delete(boardFolders).where(eq(boardFolders.boardId, boardId));
  let order = 0;
  for (const cwd of ordered) {
    const keptRow = kept.get(cwd);
    await db.insert(boardFolders).values({
      boardId,
      cwd,
      sortOrder: order++,
      tag: keptRow?.tag ?? null,
      autoRun: keptRow?.autoRun ?? false,
    });
  }
  return ordered;
}

/** Tags (short notes) of a board's folders, keyed by canonical cwd. */
export async function listBoardFolderTags(boardId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ cwd: boardFolders.cwd, tag: boardFolders.tag })
    .from(boardFolders)
    .where(eq(boardFolders.boardId, boardId));
  const tags: Record<string, string> = {};
  for (const row of rows) {
    if (row.cwd && row.tag) tags[row.cwd] = row.tag;
  }
  return tags;
}

/**
 * Set (or clear, with an empty tag) the one-line note of a folder on the
 * board. Only a folder the board already carries can be tagged — the folder
 * list and its order belong to `setBoardFolders`. Null = no such board, or
 * the board does not carry that folder.
 */
export async function setBoardFolderTag(
  boardId: string,
  cwd: string,
  tag: string,
): Promise<Record<string, string> | null> {
  const normalized = canonicalCwd(cwd);
  if (!normalized) return null;
  const board = await db
    .select({ id: boards.id })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  if (!board[0]) return null;
  const trimmed = tag.trim().slice(0, 80);
  const rows = await db
    .update(boardFolders)
    .set({ tag: trimmed || null })
    .where(and(eq(boardFolders.boardId, boardId), eq(boardFolders.cwd, normalized)))
    .returning({ cwd: boardFolders.cwd });
  if (!rows.length) return null;
  return listBoardFolderTags(boardId);
}

/**
 * Folder queue switches of a board, keyed by canonical cwd. Only switched-on
 * folders are listed — the map is read as "this folder runs in order".
 */
export async function listBoardFolderAutoRun(
  boardId: string,
): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ cwd: boardFolders.cwd, autoRun: boardFolders.autoRun })
    .from(boardFolders)
    .where(eq(boardFolders.boardId, boardId));
  const autoRun: Record<string, boolean> = {};
  for (const row of rows) {
    if (row.cwd && row.autoRun) autoRun[row.cwd] = true;
  }
  return autoRun;
}

/**
 * Switch a folder's task queue on or off. Only a folder the board already
 * carries can be switched — the folder list and its order belong to
 * `setBoardFolders`. Null = no such board, or the board does not carry that
 * folder.
 */
export async function setBoardFolderAutoRun(
  boardId: string,
  cwd: string,
  autoRun: boolean,
): Promise<Record<string, boolean> | null> {
  const normalized = canonicalCwd(cwd);
  if (!normalized) return null;
  const board = await db
    .select({ id: boards.id })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  if (!board[0]) return null;
  const rows = await db
    .update(boardFolders)
    .set({ autoRun })
    .where(and(eq(boardFolders.boardId, boardId), eq(boardFolders.cwd, normalized)))
    .returning({ cwd: boardFolders.cwd });
  if (!rows.length) return null;
  return listBoardFolderAutoRun(boardId);
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

/** Ceiling on a board's columns — a strip wider than this is unreadable anyway. */
const MAX_BOARD_COLUMNS = 24;
const MAX_COLUMN_TITLE = 60;

/** What a column write answered: the board as it stands now, or why not. */
export type BoardColumnWrite =
  | { ok: true; board: BoardDto }
  | { ok: false; reason: "notFound" | "home" | "invalid" };

function cleanColumnTitle(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, MAX_COLUMN_TITLE);
}

/** The board's columns in display order (a board with none gets its homes). */
export async function listBoardColumns(boardId: string): Promise<BoardColumnDto[]> {
  const rows = await db
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(asc(boardColumns.sortOrder), asc(boardColumns.createdAt));
  return rows.map(mapColumn);
}

/** True when the id names a column of this board (a placement may only point at one). */
export async function boardHasColumn(boardId: string, columnId: string): Promise<boolean> {
  const rows = await db
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)))
    .limit(1);
  return rows.length > 0;
}

/** Whether a column keeps its cards while the agent runs (`keepOnRun`). */
export async function boardColumnKeepsOnRun(
  boardId: string,
  columnId: string,
): Promise<boolean> {
  const rows = await db
    .select({ keepOnRun: boardColumns.keepOnRun })
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)))
    .limit(1);
  return rows[0]?.keepOnRun ?? false;
}

/** Write the given column order as `sortOrder`; ids not listed keep their tail. */
async function writeColumnOrder(boardId: string, ids: string[]): Promise<void> {
  const rows = await db
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(eq(boardColumns.boardId, boardId))
    .orderBy(asc(boardColumns.sortOrder), asc(boardColumns.createdAt));
  const known = rows.map((row) => row.id);
  const next = [
    ...ids.filter((id) => known.includes(id)),
    ...known.filter((id) => !ids.includes(id)),
  ];
  for (const [index, id] of next.entries()) {
    await db
      .update(boardColumns)
      .set({ sortOrder: index })
      .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, id)));
  }
}

/**
 * Add a column of the reader's own: a lane outside the lifecycle that holds
 * what is put in it. The four stage homes are not creatable — they come with
 * the board, and no column claims cards by a condition.
 */
export async function addBoardColumn(
  boardId: string,
  input: {
    title: string;
    /** Insert right after this column; absent = the end of the strip. */
    afterId?: string | null;
  },
): Promise<BoardColumnWrite> {
  const board = await getBoard(boardId);
  if (!board) return { ok: false, reason: "notFound" };
  if (board.columns.length >= MAX_BOARD_COLUMNS) return { ok: false, reason: "invalid" };
  const title = cleanColumnTitle(input.title);
  if (!title) return { ok: false, reason: "invalid" };
  const id = `col-${randomUUID().slice(0, 8)}`;
  await db.insert(boardColumns).values({
    id,
    boardId,
    title,
    kind: "manual",
    anchor: null,
    home: false,
    sortOrder: board.columns.length,
    sortMode: "manual",
    acceptsPrompt: true,
    // A lane holds the cards the reader drops in it: a begun turn must not take
    // them back to Wait — the switch in the editor can hand them over instead.
    keepOnRun: true,
  });
  const ids = board.columns.map((column) => column.id);
  const at = input.afterId ? ids.indexOf(input.afterId) : -1;
  ids.splice(at >= 0 ? at + 1 : ids.length, 0, id);
  await writeColumnOrder(boardId, ids);
  return { ok: true, board: (await getBoard(boardId))! };
}

/**
 * Rewrite a column: its title and its behavior. What a column *is* does not
 * change — a home stays the stage's home, a lane stays a lane — so the write
 * carries no kind, stage or rule.
 */
export async function updateBoardColumn(
  boardId: string,
  columnId: string,
  patch: {
    title?: string;
    sortMode?: BoardColumnDto["sortMode"];
    acceptsPrompt?: boolean;
    keepOnRun?: boolean;
  },
): Promise<BoardColumnWrite> {
  // A write must reach a board that carries its homes already — an old board
  // is seeded here too, so a client that only edits never meets a 404.
  if (!(await getBoard(boardId))) return { ok: false, reason: "notFound" };
  const rows = await db
    .select()
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "notFound" };
  const current = mapColumn(row);
  const title = patch.title !== undefined ? cleanColumnTitle(patch.title) : current.title;
  if (!current.home && !title) return { ok: false, reason: "invalid" };
  await db
    .update(boardColumns)
    .set({
      title,
      ...(patch.sortMode !== undefined ? { sortMode: patch.sortMode } : {}),
      ...(patch.acceptsPrompt !== undefined ? { acceptsPrompt: patch.acceptsPrompt } : {}),
      ...(patch.keepOnRun !== undefined ? { keepOnRun: patch.keepOnRun } : {}),
    })
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)));
  return { ok: true, board: (await getBoard(boardId))! };
}

/**
 * Delete a column of the reader's own. The cards stand there by placement, so
 * they are released with it: each one returns to the stage home its lifecycle
 * names, and no card is left pointing at a column that is gone.
 */
export async function deleteBoardColumn(
  boardId: string,
  columnId: string,
): Promise<BoardColumnWrite> {
  if (!(await getBoard(boardId))) return { ok: false, reason: "notFound" };
  const rows = await db
    .select({ home: boardColumns.home })
    .from(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)))
    .limit(1);
  if (!rows[0]) return { ok: false, reason: "notFound" };
  if (rows[0].home) return { ok: false, reason: "home" };
  await db
    .delete(boardColumns)
    .where(and(eq(boardColumns.boardId, boardId), eq(boardColumns.id, columnId)));
  await db
    .update(sessions)
    .set({ boardColumnId: null })
    .where(and(eq(sessions.boardId, boardId), eq(sessions.boardColumnId, columnId)));
  await writeColumnOrder(
    boardId,
    (
      await db
        .select({ id: boardColumns.id })
        .from(boardColumns)
        .where(eq(boardColumns.boardId, boardId))
        .orderBy(asc(boardColumns.sortOrder), asc(boardColumns.createdAt))
    ).map((row) => row.id),
  );
  return { ok: true, board: (await getBoard(boardId))! };
}

/** Put the board's columns in the given order (ids the board does not know are ignored). */
export async function reorderBoardColumns(
  boardId: string,
  ids: string[],
): Promise<BoardColumnWrite> {
  const board = await getBoard(boardId);
  if (!board) return { ok: false, reason: "notFound" };
  await writeColumnOrder(boardId, ids);
  return { ok: true, board: (await getBoard(boardId))! };
}
