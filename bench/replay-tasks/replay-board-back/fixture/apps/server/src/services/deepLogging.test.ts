import { describe, expect, it } from "vitest";
import { sanitizeDeepLogValue } from "./deepLogging.js";

describe("sanitizeDeepLogValue", () => {
  it("redacts sensitive keys", () => {
    expect(
      sanitizeDeepLogValue({ cursorApiKey: "secret", prompt: "hi" }),
    ).toEqual({ cursorApiKey: "[redacted]", prompt: "hi" });
  });

  it("truncates very long strings", () => {
    const long = "x".repeat(25_000);
    const out = sanitizeDeepLogValue(long);
    expect(typeof out).toBe("string");
    expect(String(out).endsWith("…[truncated]")).toBe(true);
  });
});
