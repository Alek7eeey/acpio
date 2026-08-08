import { sql } from "drizzle-orm";
import { db } from "./client.js";

/** Idempotent schema patches for local/dev without migration files. */
export async function ensureSchema() {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chat_themes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS theme_id uuid REFERENCES chat_themes(id) ON DELETE SET NULL
  `);
  await db.execute(sql`
    ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0
  `);

  await db.execute(sql`
    ALTER TABLE chat_themes
    ADD COLUMN IF NOT EXISTS path text NOT NULL DEFAULT ''
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE,
      display_name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT ''
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Drop legacy seed themes — chats stay, just ungrouped (ON DELETE SET NULL).
  await db.execute(sql`
    DELETE FROM chat_themes
    WHERE name IN ('Общее', 'Работа', 'Идеи')
  `);
}
