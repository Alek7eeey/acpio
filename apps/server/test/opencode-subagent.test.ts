// opencode wiring end to end: the fake agent speaks opencode's exact subagent
// frames ("subagent" spawn tool_call with a `name` field + child_update
// notifications), the opencode adapter must merge them into ONE subagent card
// whose identity comes from the child session id.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, useResetDb } from "./test-utils.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";
import type { MessagePartDto, SessionDetailDto } from "@acpio/shared";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

let app: FastifyInstance;
const runtimeSessionIds: string[] = [];
const tempDirs: string[] = [];

beforeEach(async () => {
  app = await buildApp();
});
useResetDb();
afterEach(async () => {
  for (const id of runtimeSessionIds.splice(0)) {
    try {
      disposeRuntime(id);
    } catch {
      /* runtime may already be gone */
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Poll GET /api/sessions/:id until fake-agent warm-up recorded acpSessionId. */
async function waitForAcpSessionId(sessionId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (res.statusCode === 200 && (res.json() as { acpSessionId?: string | null }).acpSessionId) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`acpSessionId not set within ${timeoutMs}ms`);
}

/** Poll the turn until the agent finishes (the prompt route is fire-and-forget). */
async function waitForTurnEnd(sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/turn` });
    if (res.statusCode === 200 && !(res.json() as { running?: boolean }).running) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`turn did not finish within ${timeoutMs}ms`);
}

describe("opencode adapter against the fake agent", () => {
  it("merges the spawn call and child_update frames into one subagent card", async () => {
    setAgentAvailable("opencode", true);
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        connectedProvider: "opencode",
        defaultProvider: "opencode",
        opencodeCommand: process.execPath,
        opencodeArgs: [FAKE_AGENT],
      },
    });
    expect(put.statusCode).toBe(200);

    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(created.statusCode).toBe(200);
    const session = created.json() as { id: string };
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "SUBAGENT-CHILD сколько будет 2+2?" },
    });
    expect(prompt.statusCode).toBe(200);
    await waitForTurnEnd(session.id);

    const detail = (await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}`,
    })).json() as SessionDetailDto;
    const parts = detail.messages.flatMap((m) => m.parts);
    const subagentParts = parts.filter((p: MessagePartDto) => p.type === "subagent");

    // The spawn call and the child frames share ONE card — no duplicates.
    expect(subagentParts).toHaveLength(1);
    const payload = subagentParts[0].payload as Record<string, unknown>;
    // agentId can only arrive via child_update adoption (the spawn tool result
    // carries no session id) — without the adapter mapping this stays unset.
    expect(payload.agentId).toBe("ses_childfake0001");
    expect(payload.status).toBe("completed");
    expect(payload.title).toBe("Answer 2+2");
    // The core stamps wall time when the spawn tool closes — the card header
    // renders it (opencode itself reports no metrics).
    expect(typeof payload.durationMs).toBe("number");
  });
});
