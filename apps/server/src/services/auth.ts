import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserDto } from "@acprocess/shared";
import { db } from "../db/client.js";
import { authSessions, users } from "../db/schema.js";

export const AUTH_COOKIE = "acprocess.sid";
const SESSION_DAYS = 30;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const next = scryptSync(password, salt, 64);
    const prev = Buffer.from(hash, "hex");
    if (prev.length !== next.length) return false;
    return timingSafeEqual(prev, next);
  } catch {
    return false;
  }
}

function mapUser(row: typeof users.$inferSelect): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName || row.username,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeUsername(username: string) {
  return username.trim();
}

export async function registerUser(usernameRaw: string, password: string) {
  const username = normalizeUsername(usernameRaw);
  if (!username) throw Object.assign(new Error("Укажите имя пользователя"), { statusCode: 400 });
  if (!password) throw Object.assign(new Error("Укажите пароль"), { statusCode: 400 });

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing[0]) {
    throw Object.assign(new Error("Такой пользователь уже есть"), { statusCode: 409 });
  }

  const rows = await db
    .insert(users)
    .values({
      username,
      displayName: username,
      passwordHash: hashPassword(password),
    })
    .returning();
  return mapUser(rows[0]);
}

export async function loginUser(usernameRaw: string, password: string) {
  const username = normalizeUsername(usernameRaw);
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const row = rows[0];
  if (!row || !verifyPassword(password, row.passwordHash)) {
    throw Object.assign(new Error("Неверный логин или пароль"), { statusCode: 401 });
  }
  return mapUser(row);
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
}

export async function getUserByToken(token: string | undefined): Promise<UserDto | null> {
  if (!token) return null;
  const rows = await db
    .select({ user: users })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ? mapUser(rows[0].user) : null;
}

export function readSessionToken(req: FastifyRequest) {
  return (req.cookies?.[AUTH_COOKIE] as string | undefined) ?? undefined;
}

export async function getRequestUser(req: FastifyRequest) {
  return getUserByToken(readSessionToken(req));
}

export function setAuthCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(AUTH_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export function clearAuthCookie(reply: FastifyReply) {
  reply.clearCookie(AUTH_COOKIE, { path: "/" });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  if (!newPassword) {
    throw Object.assign(new Error("Укажите новый пароль"), { statusCode: 400 });
  }
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  if (!row || !verifyPassword(currentPassword, row.passwordHash)) {
    throw Object.assign(new Error("Текущий пароль неверный"), { statusCode: 400 });
  }
  await db
    .update(users)
    .set({ passwordHash: hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function updateProfile(userId: string, displayNameRaw: string) {
  const displayName = displayNameRaw.trim();
  if (!displayName) {
    throw Object.assign(new Error("Укажите имя"), { statusCode: 400 });
  }
  if (displayName.length > 80) {
    throw Object.assign(new Error("Имя слишком длинное"), { statusCode: 400 });
  }
  const rows = await db
    .update(users)
    .set({ displayName, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!rows[0]) {
    throw Object.assign(new Error("Пользователь не найден"), { statusCode: 404 });
  }
  return mapUser(rows[0]);
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await getRequestUser(req);
  if (!user) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return user;
}
