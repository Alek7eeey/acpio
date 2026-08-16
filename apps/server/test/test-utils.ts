// Shared helpers for the server integration suite (Fastify inject + DB).
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { registerRoutes } from "../src/routes.js";

/** Fresh Fastify instance with the real route table (no listen, no logger). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  await registerRoutes(app);
  return app;
}

/** Wipe every table between tests so tests never see each other's rows. */
export async function resetDb() {
  await db.execute(sql`TRUNCATE
    auth_sessions, users, message_parts, messages, sessions, chat_themes, settings
    RESTART IDENTITY CASCADE`);
}

export function useResetDb() {
  beforeEach(async () => {
    await resetDb();
  });
}
