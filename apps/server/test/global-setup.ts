// Creates the isolated test schema and its tables (mirrors db/schema.ts).
// Runs once per vitest process before the suite; CREATE IF NOT EXISTS keeps
// it idempotent. The dev database on the same instance is never touched.
import postgres from "postgres";

const TEST_URL =
  "postgresql://acprocess:acprocess@localhost:5950/acprocess?options=-csearch_path%3Dacprocess_test";

export default async function globalSetup() {
  const sql = postgres("postgresql://acprocess:acprocess@localhost:5950/acprocess", {
    max: 1,
  });
  // Tolerate concurrent workers racing the same CREATE — "already exists" is
  // the outcome we want; any other error is real and must surface.
  const tolerant = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "42P07" || code === "42710") return; // duplicate table / extension
      throw err;
    }
  };
  try {
    await tolerant(() => sql`CREATE SCHEMA IF NOT EXISTS acprocess_test`);
    await sql`SET search_path TO acprocess_test`;
    await tolerant(() => sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS chat_themes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      path text NOT NULL DEFAULT '',
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL DEFAULT 'Новый чат',
      provider text NOT NULL DEFAULT 'cursor',
      cwd text NOT NULL DEFAULT '',
      mode text NOT NULL DEFAULT 'agent',
      status text NOT NULL DEFAULT 'idle',
      acp_session_id text,
      theme_id uuid REFERENCES chat_themes(id) ON DELETE SET NULL,
      sort_order integer NOT NULL DEFAULT 0,
      pinned boolean NOT NULL DEFAULT false,
      archived boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS message_parts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type text NOT NULL,
      "order" integer NOT NULL DEFAULT 0,
      payload jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE,
      display_name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'user',
      connected_provider text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);

    await tolerant(() => sql`CREATE TABLE IF NOT EXISTS auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  } finally {
    await sql.end();
  }
}
