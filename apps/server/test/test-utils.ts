// Shared helpers for the server integration suite (Fastify inject + DB).
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { ensureSchema } from "../src/db/ensureSchema.js";
import { registerRoutes } from "../src/routes.js";

/** Fresh Fastify instance with the real route table (no listen, no logger). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  // The in-memory DB starts empty; boot creates the tables (as index.ts does).
  await ensureSchema();
  await registerRoutes(app);
  return app;
}

/** Wipe every table between tests so tests never see each other's rows. */
export async function resetDb() {
  // Children first — FK constraints are ON in SQLite.
  for (const table of [
    "auth_sessions",
    "users",
    "message_parts",
    "messages",
    "sessions",
    "chat_themes",
    "settings",
  ]) {
    db.run(sql`DELETE FROM ${sql.raw(table)}`);
  }
}

export function useResetDb() {
  beforeEach(async () => {
    await resetDb();
  });
}
