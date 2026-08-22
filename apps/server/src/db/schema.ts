import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
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
  /** MCP server ids disabled for this chat only. */
  mcpDisabledIds: text("mcp_disabled_ids", { mode: "json" })
    .notNull()
    .$defaultFn(() => []),
  /** Latest ACP-reported token/context usage (null until/if reported). */
  usage: text("usage", { mode: "json" }),
  /** Model chosen in this chat; empty means follow settings. */
  model: text("model").notNull().default(""),
  modelParams: text("model_params", { mode: "json" })
    .notNull()
    .$defaultFn(() => ({})),
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
