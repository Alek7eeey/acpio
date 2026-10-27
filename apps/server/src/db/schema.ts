import { primaryKey, sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";

/** UUID text PK; the SQLite-level default lives in ensureSchema's DDL. */
const id = () => text("id").primaryKey().$defaultFn(() => randomUUID());

/** ms-precision timestamp stored as INTEGER (unix epoch ms). */
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const chatThemes = sqliteTable("chat_themes", {
  id: id(),
  name: text("name").notNull(),
  /** Legacy unused; session cwd is the source of truth for folders. */
  path: text("path").notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: id(),
  title: text("title").notNull().default("Новый чат"),
  provider: text("provider").notNull().default("cursor"),
  cwd: text("cwd").notNull().default(""),
  mode: text("mode").notNull().default("agent"),
  status: text("status").notNull().default("idle"),
  acpSessionId: text("acp_session_id"),
  themeId: text("theme_id").references(() => chatThemes.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  /** Starred on its board — the board's Favorites section reads this. */
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  /** MCP server ids disabled for this chat only. */
  mcpDisabledIds: text("mcp_disabled_ids", { mode: "json" })
    .notNull()
    .$defaultFn(() => []),
  /** Latest ACP-reported token/context usage (null until/if reported). */
  usage: text("usage", { mode: "json" }),
  /** Model pinned to this chat at creation; empty means follow settings (legacy rows). */
  model: text("model").notNull().default(""),
  modelParams: text("model_params", { mode: "json" })
    .notNull()
    .$defaultFn(() => ({})),
  /** Board partition: null = regular chat; otherwise the owning board id. */
  boardId: text("board_id"),
  /** Board task description (card text / first-message prefill). */
  taskDescription: text("task_description"),
  /** Board column the reader put this card in by hand (null = follow the
   *  lifecycle). Cleared by a claimed turn unless the column keeps its cards. */
  boardColumnId: text("board_column_id"),
  /** Pictures attached when the task was created: staged in acpio's own data
   *  folder and carried along by the task's first turn. */
  taskAttachments: text("task_attachments", { mode: "json" })
    .notNull()
    .$defaultFn(() => []),
  /** First turn start of a board task (Todo ⇄ Wait split). */
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  /** User-marked completion of a board task (Wait ⇄ Done). */
  doneAt: integer("done_at", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const messages = sqliteTable("messages", {
  id: id(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: createdAt(),
});

export const messageParts = sqliteTable("message_parts", {
  id: id(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  order: integer("order").notNull().default(0),
  payload: text("payload", { mode: "json" }).notNull().$defaultFn(() => ({})),
  createdAt: createdAt(),
});

/** Folders that have ever held chats — keeps empty folders visible. */
export const chatFolders = sqliteTable("chat_folders", {
  cwd: text("cwd").primaryKey(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Optional one-line note shown next to the folder name in the tree. */
  tag: text("tag"),
  createdAt: createdAt(),
});

/** Kanban boards: isolated workspaces with their own folders and tasks. */
export const boards = sqliteTable("boards", {
  id: id(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

/** The board's configured project folders, in display/group order. */
export const boardFolders = sqliteTable("board_folders", {
  id: id(),
  boardId: text("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  cwd: text("cwd").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Optional one-line note shown next to the folder name on the board. */
  tag: text("tag"),
  /**
   * Run this folder's tasks one after another: the next Todo card starts as
   * soon as the folder's running task stops, top to bottom.
   */
  autoRun: integer("auto_run", { mode: "boolean" }).notNull().default(false),
});

/**
 * A board's columns: the four stage homes (seeded with the board, undeletable)
 * and whatever lanes the reader added — a rule over a stage, or a lane of its
 * own. Order and behavior are data, so a board is arranged without a rebuild.
 */
export const boardColumns = sqliteTable("board_columns", {
  /** Stable token the board uses: `todo|progress|wait|done` for the homes,
   *  `col-…` for a column the reader added. A task's placement stores this.
   *  Unique per board — every board has a `todo`, its own row. */
  id: text("id").notNull(),
  boardId: text("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  /** Shown title; empty for a home (its name comes from i18n by id). */
  title: text("title").notNull().default(""),
  /** `stage` (the home of a lifecycle stage) | `manual` (a lane of the reader's). */
  kind: text("kind").notNull().default("manual"),
  /** The lifecycle stage a home stands for; null = a lane outside the lifecycle. */
  anchor: text("anchor"),
  /** 1 for the one column per stage the lifecycle puts cards in. */
  home: integer("home", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  /** manual | created | updated | done — the order the lane shows its cards in. */
  sortMode: text("sort_mode").notNull().default("manual"),
  acceptsPrompt: integer("accepts_prompt", { mode: "boolean" }).notNull().default(true),
  /** 1 — a begun turn leaves the card here (a lane holds what the reader put
   *  in it); 0 — the turn takes it back to the lifecycle. */
  keepOnRun: integer("keep_on_run", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.boardId, table.id] })]);

export const users = sqliteTable("users", {
  id: id(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  connectedProvider: text("connected_provider"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
});
