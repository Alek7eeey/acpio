import { createHash, timingSafeEqual } from "node:crypto";

export const REMOTE_ACCESS_COOKIE = "acp_remote";

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
