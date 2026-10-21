import { describe, expect, it } from "vitest";
import { ProcessTextDecoder } from "./processText.js";

/** «Привет» in CP866 — what a Russian Windows tool writes to its stdout. */
const OEM_POSITION = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]);
/** The same word in UTF-8, split in the middle of its first character. */
const UTF8_POSITION = Buffer.from("Сборка готова", "utf8");

describe("a child process's text", () => {
  it.skipIf(process.platform !== "win32")("reads OEM output as the text it is", () => {
    const decoder = new ProcessTextDecoder();
    expect(decoder.decode(OEM_POSITION)).toBe("Привет");
  });

  it("keeps a character that a chunk boundary splits", () => {
    const decoder = new ProcessTextDecoder();
    // Two bytes of the first character in one chunk, the rest in the next.
    const text = decoder.decode(UTF8_POSITION.subarray(0, 2)) + decoder.decode(UTF8_POSITION.subarray(2));
    expect(text).toBe("Сборка готова");
  });
});
