import { describe, expect, it } from "vitest";
import { normalizeToolCallId, toolCallIdVariants } from "./toolCallId.js";

describe("normalizeToolCallId", () => {
  it("prefers fc_ line when Cursor packs two ids", () => {
    expect(
      normalizeToolCallId(
        "call-10a4c5d2-9633-4016-8b44-68bc8b30f2c0-0\nfc_edca8e79-4a20-9011-819b-b601585f5cc7_0",
      ),
    ).toBe("fc_edca8e79-4a20-9011-819b-b601585f5cc7_0");
  });

  it("keeps a plain id", () => {
    expect(normalizeToolCallId("tool_abc")).toBe("tool_abc");
  });
});

describe("toolCallIdVariants", () => {
  it("returns all lines for store lookups", () => {
    expect(
      toolCallIdVariants(
        "call-aaa-0\nfc_bbb_0",
      ),
    ).toEqual(expect.arrayContaining(["fc_bbb_0", "call-aaa-0"]));
  });
});
