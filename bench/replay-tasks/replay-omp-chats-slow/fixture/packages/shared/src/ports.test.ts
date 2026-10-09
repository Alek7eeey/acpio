import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_PORT, resolveServerPort } from "./ports.js";

describe("resolveServerPort", () => {
  it("defaults to the dedicated API port", () => {
    expect(resolveServerPort({})).toBe(DEFAULT_SERVER_PORT);
  });

  it("ignores leftover PORT=3001 from other Node tools", () => {
    expect(resolveServerPort({ PORT: "3001" })).toBe(DEFAULT_SERVER_PORT);
    expect(resolveServerPort({ PORT: "3000" })).toBe(DEFAULT_SERVER_PORT);
    expect(resolveServerPort({ PORT: "5173" })).toBe(DEFAULT_SERVER_PORT);
  });

  it("honors ACPIO_PORT even when PORT is a popular leftover", () => {
    expect(resolveServerPort({ PORT: "3001", ACPIO_PORT: "19001" })).toBe(19001);
  });

  it("honors a non-popular PORT override", () => {
    expect(resolveServerPort({ PORT: "18799" })).toBe(18799);
  });
});
