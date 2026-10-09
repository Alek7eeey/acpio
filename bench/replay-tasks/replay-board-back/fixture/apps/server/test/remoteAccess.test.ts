import { describe, it, expect } from "vitest";
import {
  getRequestClientIp,
  isLoopbackClient,
  isLoopbackHost,
  isLoopbackIp,
  isRemoteAccessPublicPath,
  remoteAccessProtected,
  remoteKeysMatch,
  generateRemoteAccessKey,
  REMOTE_ACCESS_KEY_ALPHABET,
  REMOTE_ACCESS_KEY_LENGTH,
} from "../src/lib/remoteAccess.js";

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["localhost:18751", true],
    ["127.0.0.1", true],
    ["127.0.0.1:18741", true],
    ["[::1]", true],
    ["[::1]:18751", true],
    ["app.localhost:18751", true],
    ["192.168.1.5:18751", false],
    ["100.64.1.2", false],
    ["example.com", false],
    ["", false],
    [undefined, false],
  ])("%j → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("isLoopbackIp", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.1.5", false],
    ["10.0.0.2", false],
    ["", false],
  ])("%j → %s", (ip, expected) => {
    expect(isLoopbackIp(ip)).toBe(expected);
  });
});

describe("isLoopbackClient", () => {
  it("uses the forwarded client IP behind dev proxy", () => {
    expect(
      isLoopbackClient({
        ip: "127.0.0.1",
        headers: { host: "192.168.1.9:18751", "x-forwarded-for": "192.168.1.50" },
      }),
    ).toBe(false);
  });

  it("treats direct localhost connections as local", () => {
    expect(
      isLoopbackClient({
        ip: "127.0.0.1",
        headers: { host: "localhost:18751" },
      }),
    ).toBe(true);
  });
});

describe("getRequestClientIp", () => {
  it("prefers the first X-Forwarded-For hop", () => {
    expect(
      getRequestClientIp({
        ip: "127.0.0.1",
        headers: { "x-forwarded-for": "192.168.1.50, 127.0.0.1" },
      }),
    ).toBe("192.168.1.50");
  });
});

describe("generateRemoteAccessKey", () => {
  it("returns 8 characters from the unambiguous alphabet", () => {
    const key = generateRemoteAccessKey();
    expect(key).toHaveLength(REMOTE_ACCESS_KEY_LENGTH);
    expect([...key].every((ch) => REMOTE_ACCESS_KEY_ALPHABET.includes(ch))).toBe(true);
  });
});

describe("remoteKeysMatch", () => {
  it("accepts an exact match", () => {
    expect(remoteKeysMatch("abc", "abc")).toBe(true);
  });

  it("rejects a mismatch or empty", () => {
    expect(remoteKeysMatch("abc", "abd")).toBe(false);
    expect(remoteKeysMatch("", "abc")).toBe(false);
    expect(remoteKeysMatch("abc", "")).toBe(false);
    expect(remoteKeysMatch(undefined, "abc")).toBe(false);
  });
});

describe("remote access paths", () => {
  it("keeps health and unlock public", () => {
    expect(isRemoteAccessPublicPath("/api/health")).toBe(true);
    expect(isRemoteAccessPublicPath("/api/remote-access")).toBe(true);
    expect(isRemoteAccessPublicPath("/api/remote-access?x=1")).toBe(true);
    expect(isRemoteAccessPublicPath("/api/settings")).toBe(false);
  });

  it("protects api and websocket", () => {
    expect(remoteAccessProtected("/api/settings")).toBe(true);
    expect(remoteAccessProtected("/ws")).toBe(true);
    expect(remoteAccessProtected("/")).toBe(false);
  });
});
