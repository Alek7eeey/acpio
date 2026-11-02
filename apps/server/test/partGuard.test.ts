// Stop closes the tool calls a turn left open, and it must not rewrite the ones
// that already earned a final status — the agent's own update lands whenever it
// lands, and the transcript a reader watched happen is worth more than the
// spinner Stop was trying to clear.
//
// The guard therefore lives inside the UPDATE, not in a read before it: the
// third test starts Stop's write before the "completed" write and expects the
// finished call to survive anyway. A read-then-write guard loses that one.

import { describe, it, expect, beforeEach } from "vitest";
import { buildApp, resetDb } from "./test-utils.js";
import {
  appendPart,
  cancelPartIfOpen,
  createMessage,
  createSession,
  getPartPayload,
  updatePart,
} from "../src/services/sessions.js";

const TERMINAL = ["completed", "failed", "cancelled"];

let sessionId: string;

beforeEach(async () => {
  await buildApp();
  await resetDb();
  const session = await createSession({ provider: "builtin", cwd: ".", mode: "agent" });
  sessionId = session.id;
});

async function toolPart(status: string) {
  const message = await createMessage(sessionId, "assistant");
  return appendPart(sessionId, message.id, "tool_call", { title: "bash", status });
}

describe("cancelPartIfOpen", () => {
  it("leaves a finished call alone", async () => {
    const part = await toolPart("completed");
    expect(await cancelPartIfOpen(sessionId, part.id, TERMINAL)).toBeNull();
    const payload = await getPartPayload(part.id);
    expect(payload?.status).toBe("completed");
    expect(payload?.interrupted).toBeUndefined();
  });

  it("closes a call that is still open", async () => {
    const part = await toolPart("in_progress");
    expect((await cancelPartIfOpen(sessionId, part.id, TERMINAL))?.payload.status).toBe("cancelled");
    const payload = await getPartPayload(part.id);
    expect(payload?.status).toBe("cancelled");
    expect(payload?.interrupted).toBe(true);
  });

  it("keeps a call that finishes while Stop is closing it", async () => {
    const part = await toolPart("in_progress");
    // Stop walks the map first, the agent's terminal update arrives second —
    // the order that used to leave finished work marked as halted.
    const stopping = cancelPartIfOpen(sessionId, part.id, TERMINAL);
    const finishing = updatePart(sessionId, part.id, { status: "completed" });
    await Promise.all([stopping, finishing]);
    expect((await getPartPayload(part.id))?.status).toBe("completed");
  });
});
