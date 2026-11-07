// Stop must win over a turn that has not reached the wire yet.
//
// The prompt route answers the moment it hands the text to `runPrompt`, so the
// composer offers Stop while the turn is still booting: no client, no
// `session/prompt`, nothing for `session/cancel` to reach. That turn used to
// start anyway — the agent was asked the question the reader had already
// halted, and the answer landed in the chat after the "stopped" note.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { buildApp, useResetDb } from "./test-utils.js";
import { setAgentAvailable, disposeRuntime } from "../src/acp/sessionManager.js";
import type { SessionDetailDto } from "@acpio/shared";

let app: FastifyInstance;
const tempDirs: string[] = [];
const sessionIds: string[] = [];

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  for (const id of sessionIds.splice(0)) disposeRuntime(id);
  await app.close();
  for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});
useResetDb();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Model stub: one answer per call, half a second after it is asked. */
async function startStub() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.setHeader("content-type", "text/event-stream");
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "stub",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      setTimeout(() => {
        res.write(chunk({ content: " ОТВЕТ" }, null));
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
        );
        res.end();
      }, 500);
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(closed.resolve);
      return closed.promise;
    },
  };
}

async function openSession(url: string) {
  setAgentAvailable("builtin", true);
  await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      connectedProvider: "builtin",
      defaultProvider: "builtin",
      chatAutoTitle: false,
      builtinProjectRules: [],
      builtinProviders: [
        { id: "p1", name: "Local", url, apiKey: "", models: [{ id: "m1", label: "M1", contextWindow: 60_000 }] },
      ],
    },
  });
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-stop-boot-"));
  tempDirs.push(cwd);
  const created = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { provider: "builtin", cwd },
  });
  const id = (created.json() as { id: string }).id;
  sessionIds.push(id);
  return id;
}

function parts(detail: SessionDetailDto): string[] {
  return detail.messages
    .flatMap((m) => m.parts)
    .map((p) => `${p.type}:${String((p.payload as Record<string, unknown>).text ?? "")}`);
}

describe("Stop while the turn is still booting", () => {
  it("never asks the agent the question the reader halted", async () => {
    const stub = await startStub();
    const id = await openSession(stub.url);
    const prompt = app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "привет" },
    });
    // The Stop a fast click gives: the prompt is on the wire, the turn is not.
    await sleep(5);
    await app.inject({ method: "POST", url: `/api/sessions/${id}/cancel` });
    await prompt;
    await sleep(2_000);
    const detail = (await app.inject({ method: "GET", url: `/api/sessions/${id}` })).json() as SessionDetailDto;
    expect(stub.calls()).toBe(0);
    expect(detail.status).toBe("idle");
    expect(parts(detail)).toContain("text:привет");
    expect(parts(detail).some((p) => p.startsWith("note:"))).toBe(true);
    expect(parts(detail).some((p) => p.includes("ОТВЕТ"))).toBe(false);
    await stub.close();
  }, 30_000);

  it("does not silence the turn the reader sends after Stop", async () => {
    const stub = await startStub();
    const id = await openSession(stub.url);
    await app.inject({ method: "POST", url: `/api/sessions/${id}/cancel` });
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "другое дело" },
    });
    await sleep(2_000);
    const detail = (await app.inject({ method: "GET", url: `/api/sessions/${id}` })).json() as SessionDetailDto;
    expect(stub.calls()).toBe(1);
    expect(detail.status).toBe("idle");
    expect(parts(detail).some((p) => p.includes("ОТВЕТ"))).toBe(true);
    await stub.close();
  }, 30_000);
});
