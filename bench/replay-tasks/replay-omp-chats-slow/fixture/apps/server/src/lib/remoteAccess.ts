import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const REMOTE_ACCESS_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REMOTE_ACCESS_KEY_LENGTH = 8;

/** Random LAN/phone access key (no ambiguous 0/O/1/I). */
export function generateRemoteAccessKey(): string {
  const bytes = randomBytes(REMOTE_ACCESS_KEY_LENGTH);
  let out = "";
  for (let i = 0; i < REMOTE_ACCESS_KEY_LENGTH; i++) {
    out += REMOTE_ACCESS_KEY_ALPHABET[bytes[i]! % REMOTE_ACCESS_KEY_ALPHABET.length];
  }
  return out;
}

export const REMOTE_ACCESS_COOKIE = "acp_remote";

type RequestLike = {
  ip?: string;
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string | null };
};

export function normalizeClientIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export function isLoopbackIp(ip: string): boolean {
  const normalized = normalizeClientIp(ip);
  return normalized === "127.0.0.1" || normalized === "::1";
}

/** @deprecated Prefer isLoopbackClient — Host can be localhost behind a LAN proxy. */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) return false;
  const hostname = host.startsWith("[")
    ? (host.slice(1).split("]")[0] ?? "")
    : host.split(":")[0] ?? "";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

export function getRequestClientIp(req: RequestLike): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) return normalizeClientIp(first);
  }
  const xReal = req.headers["x-real-ip"];
  if (typeof xReal === "string" && xReal.trim()) {
    return normalizeClientIp(xReal);
  }
  if (req.ip) return normalizeClientIp(req.ip);
  return normalizeClientIp(req.socket?.remoteAddress ?? "");
}

/** True when the TCP client is the same machine (localhost / loopback). */
export function isLoopbackClient(req: RequestLike): boolean {
  return isLoopbackIp(getRequestClientIp(req));
}

export function remoteKeysMatch(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function isRemoteAccessPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === "/api/health" || path === "/api/remote-access";
}

export function remoteAccessProtected(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === "/ws" || path.startsWith("/api/");
}
