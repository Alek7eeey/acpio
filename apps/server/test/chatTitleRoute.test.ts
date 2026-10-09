// The feature's front door: the first prompt of a chat names it from the
// message as always, then a builtin-provider model rewrites that name. This
// drives the real prompt route (fake agent for the turn, local stub for the
// model), because the title is what a user of the feature actually sees.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { SessionDetailDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";

/** Deterministic fake ACP agent — the turn itself must not need a real one. */
const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

let app: FastifyInstance;
const runtimeSessionIds: string[] = [];

/** Local OpenAI-compatible stub answering /chat/completions. */
let modelServer: http.Server;
let modelUrl = "";
let modelCalls = 0;
let modelReply = "Красивая задача";

function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

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

/** Turn the title feature on with one provider row pointing at the stub. */
function enableAutoTitle(reply = "Красивая задача") {
  modelReply = reply;
  return app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      chatAutoTitle: true,
      builtinProviders: [
        {
          id: "stub",
          name: "Stub",
          url: modelUrl,
          apiKey: "",
          models: [{ id: "stub-1", label: "Stub One", contextWindow: 8_000 }],
        },
      ],
    },
  });
}

/** Poll GET /api/sessions/:id until `check` passes (real child process → poll). */
async function waitForDetail(
  sessionId: string,
  check: (detail: SessionDetailDto) => boolean,
  timeoutMs = 8000,
): Promise<SessionDetailDto> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (res.statusCode === 200) {
      const detail = res.json() as SessionDetailDto;
      if (check(detail)) return detail;
      last = detail.title;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`condition not met within ${timeoutMs}ms (last title=${last})`);
}

beforeEach(async () => {
  app = await buildApp();
  modelCalls = 0;
  modelServer = http.createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    modelCalls++;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  modelUrl = `http://127.0.0.1:${portOf(modelServer)}/v1`;
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
  setAgentAvailable("omp", false);
  await new Promise<void>((resolve, reject) =>
    modelServer.close((err) => (err ? reject(err) : resolve())),
  );
  await app.close();
});

async function newChat(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
  expect(res.statusCode).toBe(200);
  const session = res.json() as { id: string };
  runtimeSessionIds.push(session.id);
  return session.id;
}

describe("chat title from the model", () => {
  it("first message names the chat, the model then rewrites it", async () => {
    await connectAgent();
    await enableAutoTitle("Красивая задача");
    const id = await newChat();

    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "почини баг с рендером таблицы" },
    });
    expect(prompt.statusCode).toBe(200);

    const detail = await waitForDetail(id, (d) => d.title === "Красивая задача");
    // The message-derived title came first — the model refines it, it does not
    // race it. Two calls would mean the turn fired the refinement twice.
    expect(modelCalls).toBeGreaterThanOrEqual(1);
    expect(detail.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("keeps the message-derived title when the feature is off", async () => {
    await connectAgent();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { chatAutoTitle: false },
    });
    const id = await newChat();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "почини баг с рендером таблицы" },
    });

    const detail = await waitForDetail(id, (d) => d.messages.some((m) => m.role === "user"));
    expect(detail.title).toBe("почини баг с рендером таблицы");
    expect(modelCalls).toBe(0);
  });

  it("leaves a hand-renamed chat alone", async () => {
    await connectAgent();
    await enableAutoTitle();
    const id = await newChat();
    // Rename before the first message: the title is no longer auto-derived.
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "Моё название" },
    });
    expect(patch.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "первое сообщение" },
    });
    const detail = await waitForDetail(id, (d) => d.messages.some((m) => m.role === "user"));
    expect(detail.title).toBe("Моё название");
    expect(modelCalls).toBe(0);
  });

  it("does not re-fire on a later message", async () => {
    await connectAgent();
    await enableAutoTitle();
    const id = await newChat();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "первое сообщение" },
    });
    await waitForDetail(id, (d) => d.title === "Красивая задача");
    const callsAfterFirst = modelCalls;

    // Second message: the title is already model-written (no longer
    // auto-derived) and it is not the first message either.
    modelReply = "Другое название";
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "второе сообщение" },
    });
    await waitForDetail(id, (d) => d.messages.some((m) => m.role === "user" && m.parts.some((p) => typeof p.payload.text === "string" && p.payload.text.includes("второе"))));
    // Give the (wrongly expected) refinement time to land, then prove it didn't.
    await new Promise((r) => setTimeout(r, 300));
    expect(modelCalls).toBe(callsAfterFirst);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${id}` })).json().title).toBe(
      "Красивая задача",
    );
  });

  it("keeps the message title when the model endpoint is down", async () => {
    await connectAgent();
    await enableAutoTitle();
    // Point the provider at a closed port after enabling: the settings read at
    // prompt time has no live endpoint.
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        chatAutoTitle: true,
        builtinProviders: [
          {
            id: "stub",
            name: "Stub",
            url: "http://127.0.0.1:9/v1",
            apiKey: "",
            models: [{ id: "stub-1", label: "Stub One", contextWindow: 8_000 }],
          },
        ],
      },
    });
    const id = await newChat();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "задача остаётся из сообщения" },
    });
    const detail = await waitForDetail(id, (d) => d.messages.some((m) => m.role === "user"));
    expect(detail.title).toBe("задача остаётся из сообщения");
  });
});
