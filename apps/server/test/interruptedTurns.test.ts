// Boot after a crash: a chat that was mid-turn must carry on by itself.
// `reconcileStaleSessions` hands the ids back, `resumeInterruptedTurns` re-drives
// them, and the work continues on the agent session the dead process left behind
// — the user should not have to find the chat and send a message again.
//
// The assertions go through the chat itself: the continuation prompt lands in the
// transcript and the fake agent echoes it back, so a turn that never reached the
// agent fails the check.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { SessionDetailDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { sessions as sessionsTable } from "../src/db/schema.js";
import {
  disposeRuntime,
  resumeInterruptedTurns,
  setAgentAvailable,
} from "../src/acp/sessionManager.js";
import {
  appendPart,
  createMessage,
  reconcileStaleSessions,
} from "../src/services/sessions.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

let app: FastifyInstance;
const runtimeSessionIds: string[] = [];
const tempDirs: string[] = [];

/** Continuation wording, as the en locale (the default) renders it. */
const CONTINUATION = "The previous acpio run was interrupted in the middle of this turn";
const RESEND_NOTE = "Сервер был перезапущен — этот ход прерван. Отправьте сообщение ещё раз.";

/** PUT /api/settings {connectedProvider:'omp'} pointing at the fake agent. */
function connectAgent() {
  setAgentAvailable("omp", true);
  return app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      connectedProvider: "omp",
      defaultProvider: "omp",
      ompCommand: process.execPath,
      ompArgs: [FAKE_AGENT],
    },
  });
}

/**
 * A chat exactly as the previous process left it: mid-turn, with a tool call the
 * death froze in "in_progress" and the agent session it would come back to.
 */
async function seedInterruptedChat(
  opts: { cwd?: string; question?: boolean } = {},
): Promise<string> {
  const cwd = opts.cwd ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-interrupted-")));
  if (!opts.cwd) tempDirs.push(cwd);
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: "Was working",
      provider: "omp",
      cwd,
      mode: "agent",
      status: opts.question ? "waiting" : "running",
      acpSessionId: "fake-sess-4242",
    })
    .returning();
  runtimeSessionIds.push(row.id);

  const user = await createMessage(row.id, "user");
  await appendPart(row.id, user.id, "text", { text: "отрефактори модуль" });
  const assistant = await createMessage(row.id, "assistant");
  await appendPart(row.id, assistant.id, "text", { text: "начал работу" });
  await appendPart(row.id, assistant.id, "tool_call", {
    toolCallId: "t-1",
    title: "edit",
    status: "in_progress",
  });
  if (opts.question) {
    await appendPart(row.id, assistant.id, "question", {
      requestId: `${row.id}:q`,
      pending: true,
      title: "Какой цвет?",
      questions: [],
    });
  }
  return row.id;
}

function partsOf(detail: SessionDetailDto, role?: string) {
  return detail.messages
    .filter((m) => !role || m.role === role)
    .flatMap((m) => m.parts);
}

function textParts(detail: SessionDetailDto, role?: string): string[] {
  return partsOf(detail, role)
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""));
}

async function readDetail(sessionId: string): Promise<SessionDetailDto> {
  const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
  return res.json() as SessionDetailDto;
}

async function waitForDetail(
  sessionId: string,
  predicate: (detail: SessionDetailDto) => boolean,
  timeoutMs = 10_000,
): Promise<SessionDetailDto> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionDetailDto | null = null;
  while (Date.now() < deadline) {
    last = await readDetail(sessionId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms: ${JSON.stringify(last?.status)}`);
}

beforeEach(async () => {
  app = await buildApp();
});
useResetDb();
afterEach(async () => {
  for (const id of runtimeSessionIds.splice(0)) {
    try {
      disposeRuntime(id);
    } catch {
      // runtime may already be gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await app.close();
});

describe("interrupted turns, resumed at boot", () => {
  it("continues a chat that was mid-turn when the previous process died", async () => {
    await connectAgent();
    const sessionId = await seedInterruptedChat();

    const recovered = await reconcileStaleSessions();
    expect(recovered.interrupted).toEqual([sessionId]);

    const continuing = await resumeInterruptedTurns(recovered.interrupted);
    expect(continuing).toEqual([sessionId]);

    // The turn really reached the agent: it echoed the continuation prompt back.
    const resumed = await waitForDetail(sessionId, (d) =>
      textParts(d).some((text) => text.includes(`echo: ${CONTINUATION}`)),
    );
    const prompt = textParts(resumed, "user").find((text) => text.includes(CONTINUATION));
    expect(prompt).toContain("Continue from where you stopped");
    // The resumed turn ends like any other: the chat unlocks again.
    const settled = await waitForDetail(sessionId, (d) => d.status === "idle");

    // The frozen tool call was settled by the sweep, not left spinning.
    const tool = partsOf(settled).find((p) => p.type === "tool_call");
    expect(tool?.payload.status).toBe("error");
    expect(tool?.payload.interrupted).toBe(true);
  });

  it("leaves interrupted chats alone when auto-continue is off", async () => {
    await connectAgent();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { resumeInterruptedTurns: false },
    });
    const sessionId = await seedInterruptedChat();

    const recovered = await reconcileStaleSessions();
    expect(recovered.interrupted).toEqual([]);
    expect(recovered.sessions).toBe(1);

    expect(await resumeInterruptedTurns(recovered.interrupted)).toEqual([]);
    // Nothing may be scheduled behind our back either.
    await new Promise((r) => setTimeout(r, 400));

    const after = await readDetail(sessionId);
    expect(textParts(after).some((text) => text.includes(CONTINUATION))).toBe(false);
    expect(after.status).toBe("idle");
    // The user is told plainly instead: this turn is gone, send it again.
    const note = partsOf(after).find((p) => p.type === "error");
    expect(note?.payload.message).toBe(RESEND_NOTE);
  });

  it("does not continue a chat parked on an unanswered question", async () => {
    await connectAgent();
    const sessionId = await seedInterruptedChat({ question: true });

    const recovered = await reconcileStaleSessions();
    expect(recovered.sessions).toBe(0);
    expect(recovered.interrupted).toEqual([]);

    await new Promise((r) => setTimeout(r, 300));
    const after = await readDetail(sessionId);
    expect(after.status).toBe("waiting");
    expect(partsOf(after).find((p) => p.type === "question")?.payload.pending).toBe(true);
    expect(textParts(after).some((text) => text.includes(CONTINUATION))).toBe(false);
  });

  it("skips chats whose harness is switched off", async () => {
    await connectAgent();
    const sessionId = await seedInterruptedChat();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { disabledProviders: ["omp"] },
    });

    const recovered = await reconcileStaleSessions();
    expect(recovered.sessions).toBe(1);
    expect(recovered.interrupted).toEqual([]);

    await new Promise((r) => setTimeout(r, 300));
    const after = await readDetail(sessionId);
    expect(after.status).toBe("idle");
    expect(textParts(after).some((text) => text.includes(CONTINUATION))).toBe(false);
  });

  it("skips chats whose working folder is gone", async () => {
    await connectAgent();
    const sessionId = await seedInterruptedChat({
      cwd: path.join(os.tmpdir(), `acpio-gone-${Date.now()}-${Math.random()}`),
    });

    const recovered = await reconcileStaleSessions();
    expect(recovered.interrupted).toEqual([]);
    expect(await resumeInterruptedTurns(recovered.interrupted)).toEqual([]);
    expect(textParts(await readDetail(sessionId)).some((t) => t.includes(CONTINUATION))).toBe(
      false,
    );
  });

});