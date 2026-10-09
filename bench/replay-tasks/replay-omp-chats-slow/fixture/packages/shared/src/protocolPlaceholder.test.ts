import { describe, expect, it } from "vitest";
import { isProtocolPlaceholder } from "./protocolPlaceholder.js";

describe("isProtocolPlaceholder", () => {
  it("matches the harness filler in whatever whitespace it arrives", () => {
    expect(isProtocolPlaceholder("[System: Empty message content sanitised to satisfy protocol]")).toBe(true);
    expect(isProtocolPlaceholder("  [system:  empty message content sanitised to satisfy protocol ]\n")).toBe(true);
  });

  it("leaves real content and other bracketed system notes alone", () => {
    expect(isProtocolPlaceholder("Working on it.")).toBe(false);
    expect(isProtocolPlaceholder("[System: Empty message content sanitised to satisfy protocol] and more")).toBe(false);
    expect(isProtocolPlaceholder("[System: something else]")).toBe(false);
    expect(isProtocolPlaceholder("")).toBe(false);
  });
});
