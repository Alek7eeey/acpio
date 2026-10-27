import { sql } from "drizzle-orm";
import { db } from "./client.js";

function isDuplicateColumn(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const causeMsg =
    err && typeof err === "object" && "cause" in err && err.cause instanceof Error
      ? err.cause.message
      : "";
  return /duplicate column/i.test(msg) || /duplicate column/i.test(causeMsg);
}

/**
 * Idempotent schema bootstrap for local/dev without migration files.
 * SQLite dialect; mirrors src/db/schema.ts. Called at server boot, so a
 * fresh clone works without running drizzle-kit push first.
 */
export async function ensureSchema() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS chat_themes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      title TEXT NOT NULL DEFAULT 'Новый чат',
      provider TEXT NOT NULL DEFAULT 'cursor',
      cwd TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'idle',
      acp_session_id TEXT,
      theme_id TEXT REFERENCES chat_themes(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      favorite INTEGER NOT NULL DEFAULT 0,
      mcp_disabled_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // Idempotent migration: CREATE TABLE IF NOT EXISTS above won't alter an
  // existing sessions table, so add the column here if it's missing.
  // drizzle wraps the SqliteError in a DrizzleError, so inspect both the
  // message and the underlying cause when tolerating "already exists".
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN usage TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN model_params TEXT NOT NULL DEFAULT '{}'`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN board_id TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN task_description TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN task_attachments TEXT NOT NULL DEFAULT '[]'`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN started_at INTEGER`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN done_at INTEGER`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }
  // A board card the user starred: the board's Favorites section lists it.
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS message_parts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Opening a chat reads every part of every message of that session. Without
  // these indexes each per-message parts lookup is a full scan of
  // message_parts — 500+ MB in a long-lived install, ~40 s per large chat.
  db.run(sql`CREATE INDEX IF NOT EXISTS messages_session_created_idx
    ON messages(session_id, created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS message_parts_message_idx
    ON message_parts(message_id, "order", created_at)`);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  // Folders that have ever held chats — survives deleting the last chat, so
  // empty folders stay visible across devices until explicitly removed.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS chat_folders (
      cwd TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  try {
    db.run(sql`ALTER TABLE chat_folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  // Optional one-line note shown next to the folder name in the chat tree.
  try {
    db.run(sql`ALTER TABLE chat_folders ADD COLUMN tag TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS board_folders (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      cwd TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS board_folders_board_cwd
    ON board_folders(board_id, cwd)
  `);

  // Optional one-line note shown next to the folder name on the board.
  try {
    db.run(sql`ALTER TABLE board_folders ADD COLUMN tag TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  // Folder runs its tasks one after another (task queue), off by default.
  try {
    db.run(sql`ALTER TABLE board_folders ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  // Columns are the board's own data: the four stage homes plus the lanes the
  // reader adds. A board that has none is seeded on its first read
  // (ensureBoardColumns), so an older database upgrades without a migration.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS board_columns (
      id TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'manual',
      anchor TEXT,
      home INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      sort_mode TEXT NOT NULL DEFAULT 'manual',
      accepts_prompt INTEGER NOT NULL DEFAULT 1,
      keep_on_run INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (board_id, id)
    )
  `);

  db.run(sql`
    CREATE INDEX IF NOT EXISTS board_columns_board_order
    ON board_columns(board_id, sort_order)
  `);

  // A lane holds what the reader put in it: `keep_on_run` now defaults to 1,
  // because a hand placement is a decision and not a step of the lifecycle.
  // Rows written under the old default carry 0, which reads as “a begun turn
  // takes the card back” — flip those once, marked in `user_version`, so a lane
  // the reader switches off afterwards stays off on the next boot.
  const version = db.get(sql`PRAGMA user_version`) as { user_version?: number } | undefined;
  if ((version?.user_version ?? 0) < 1) {
    db.run(sql`UPDATE board_columns SET keep_on_run = 1 WHERE home = 0`);
    db.run(sql`PRAGMA user_version = 1`);
  }

  // The column a card was placed in by hand; NULL = follow the lifecycle.
  try {
    db.run(sql`ALTER TABLE sessions ADD COLUMN board_column_id TEXT`);
  } catch (err) {
    if (!isDuplicateColumn(err)) throw err;
  }

  db.run(sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      connected_provider TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  // Drop legacy seed themes — chats stay, just ungrouped (ON DELETE SET NULL).
  db.run(sql`
    DELETE FROM chat_themes
    WHERE name IN ('Общее', 'Работа', 'Идеи')
  `);
}
