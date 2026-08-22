import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  isRemoteAccessPublicPath,
  remoteAccessProtected,
  remoteKeysMatch,
} from "../src/lib/remoteAccess.js";

describe("isLoopbackHost", () => {
  it.each([
    ["localhost", true],
    ["localhost:5173", true],
    ["127.0.0.1", true],
    ["127.0.0.1:3001", true],
    ["[::1]", true],
    ["[::1]:5173", true],
    ["app.localhost:5173", true],
    ["192.168.1.5:5173", false],
    ["100.64.1.2", false],
    ["example.com", false],
    ["", false],
    [undefined, false],
  ])("%j → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
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
