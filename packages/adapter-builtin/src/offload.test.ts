import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { OffloadStore, offloadId, offloadToolResults } from "./offload.js";

/** A `glob` answer the size of the one that moved the head of chat c88a1a10. */
const BULKY = `1.1 MB  7zap.html\n${"step-parse output\n".repeat(1_200)}`;

function call(callId = "call_1"): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: callId, toolName: "glob", input: { pattern: "*" } }],
  } as ModelMessage;
}

function answer(text: string, callId = "call_1"): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: callId, toolName: "glob", output: { type: "text", value: text } },
    ],
  } as ModelMessage;
}

/** What the model would read in that message: the citation, or the bytes. */
function textOf(messages: ModelMessage[], index: number): string {
  const part = (messages[index]!.content as Array<{ output: { value: string } }>)[0]!;
  return part.output.value;
}

describe("archive of bulky tool answers", () => {
  let dir = "";
  let store: OffloadStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-"));
    store = OffloadStore.forSession(dir, "sess-1");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("archives an answer over the line the first time it goes on the wire", () => {
    const out = offloadToolResults([call(), answer(BULKY)], store, 4_000, 0);

    expect(textOf(out, 1)).toContain("[offloaded file=");
    expect(store.has(offloadId("glob", "call_1"))).toBe(true);
    // Reversible: the bytes are on disk, and the citation says where.
    const file = textOf(out, 1).match(/file=(\S+)/)?.[1] ?? "";
    expect(fs.readFileSync(file, "utf8")).toBe(BULKY);
  });

  it("leaves an answer alone when the line is lowered after it went out", () => {
    const messages = [call(), answer(BULKY)];
    // The request that carried it: the line sat above the answer, so the model
    // read the whole thing — and the boundary moved past it.
    const first = offloadToolResults(messages, store, 8_000, 0);
    expect(textOf(first, 1)).toBe(BULKY);

    // Next turn the line is lowered to 4 000. Archiving it now would rewrite a
    // message in the middle of the prompt: every message after it moves, the
    // provider's cache stops there, and the rest is billed again.
    const later = offloadToolResults(messages, store, 4_000, messages.length);
    expect(textOf(later, 1)).toBe(BULKY);
    expect(store.has(offloadId("glob", "call_1"))).toBe(false);
  });

  it("keeps a citation that has already been on the wire", () => {
    const messages = [call(), answer(BULKY)];
    const first = offloadToolResults(messages, store, 4_000, 0);
    expect(textOf(first, 1)).toContain("[offloaded file=");

    // The switch turned off, and a line that would archive nothing: the model
    // saw a citation, so it keeps seeing one instead of the bytes coming back.
    const off = offloadToolResults(messages, store, 0, messages.length);
    expect(textOf(off, 1)).toContain("[offloaded file=");
    expect(textOf(off, 1)).not.toBe(BULKY);
  });
});
