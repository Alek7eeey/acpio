import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";
import { isValidSessionId, loadBuiltinSession, saveBuiltinSession } from "./store.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acpio-builtin-"));
  created.push(dir);
  return dir;
}

interface InitResult {
  protocolVersion: number;
  agentCapabilities: { loadSession?: boolean };
  agentInfo: { name: string; title: string; version: string };
}

interface SessionResult {
  sessionId: string;
  configOptions: Array<{
    id: string;
    currentValue?: string;
    options?: Array<{ value: string; name: string }>;
  }>;
}

interface Harness {
  /** Request/reply over the line transport; rejects on an RPC error. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Every frame the agent emitted, in order. */
  frames: Array<Record<string, unknown>>;
  close(): void;
  /** How many times the agent reported itself closed. */
  closes(): number;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}

function boot(overrides: Partial<AppSettings> = {}, stateDir = tempDir()): Harness {
  const agent = createBuiltinTransport({
    settings: { ...DEFAULT_SETTINGS, ...overrides },
    cwd: stateDir,
    mode: "agent",
    stateDir,
  });

  const frames: Array<Record<string, unknown>> = [];
  const pending = new Map<number, (frame: Record<string, unknown>) => void>();
  let nextId = 1;
  let closes = 0;
  agent.onClose(() => {
    closes += 1;
  });

  agent.onLine((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    frames.push(frame);
    if (typeof frame.id !== "number") return;
    const resolver = pending.get(frame.id);
    if (!resolver) return;
    pending.delete(frame.id);
    resolver(frame);
  });

  // Replies arrive on the agent's own async turns — await them, never a timer.
  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (frame) => {
        if (frame.error) reject(new Error(errorMessage(frame.error)));
        else {
          // The caller picks T from the method it called; frames are plain JSON.
          const result = frame.result as T;
          resolve(result);
        }
      });
      agent.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

  return {
    call,
    frames,
    close: () => agent.close(),
    closes: () => closes,
  };
}

describe("BuiltinAgent ACP surface", () => {
  it("initialize reports the agent and session restore capability", async () => {
    const { call } = boot();
    const res = await call<InitResult>("initialize", { protocolVersion: 1 });
    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities.loadSession).toBe(true);
    expect(res.agentInfo.name).toBe("acpio-builtin");
  });

  it("session/new mints an id and lists the configured models", async () => {
    const { call } = boot({
      builtinProviders: [
        {
          id: "p1",
          name: "Test",
          url: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: [{ id: "m1", label: "Model One", contextWindow: 8_000 }],
        },
      ],
    });
    const res = await call<SessionResult>("session/new", { cwd: "/w" });
    expect(res.sessionId).toBeTruthy();
    const model = res.configOptions.find((o) => o.id === "model");
    expect(model?.options).toEqual([{ value: "p1::m1", name: "Model One" }]);
  });

  it("normalizes a bare legacy model id when the harness applies it", async () => {
    const { call } = boot({
      builtinProviders: [
        {
          id: "p1",
          name: "Test",
          url: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: [{ id: "m1", label: "Model One", contextWindow: 8_000 }],
        },
      ],
    });
    await call("session/new", { cwd: "/w" });
    const res = await call<{ configOptions: Array<{ id: string; currentValue?: string }> }>(
      "session/set_config_option",
      { configId: "model", value: "m1" },
    );
    expect(res.configOptions.find((o) => o.id === "model")?.currentValue).toBe("p1::m1");
  });

  it("turns down a model value no provider serves", async () => {
    const { call } = boot({
      builtinProviders: [
        {
          id: "p1",
          name: "Test",
          url: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: [{ id: "m1", label: "Model One", contextWindow: 8_000 }],
        },
      ],
    });
    await call("session/new", { cwd: "/w" });
    await expect(
      call("session/set_config_option", { configId: "model", value: "p1::ghost" }),
    ).rejects.toThrow(/не найдена/);
  });

  it("normalizes a bare model id restored from a pre-provider conversation", async () => {
    const dir = tempDir();
    saveBuiltinSession(dir, "old-1", {
      version: 1,
      cwd: "/w",
      modelId: "m1",
      messages: [],
    });
    const { call } = boot(
      {
        builtinProviders: [
          {
            id: "p1",
            name: "Test",
            url: "http://127.0.0.1:1/v1",
            apiKey: "",
            models: [{ id: "m1", label: "Model One", contextWindow: 8_000 }],
          },
        ],
      },
      dir,
    );
    const res = await call<SessionResult>("session/load", { sessionId: "old-1", cwd: "/w" });
    const model = res.configOptions.find((o) => o.id === "model");
    expect(model?.currentValue).toBe("p1::m1");
  });

  it("session/load keeps the id the harness asks for", async () => {
    const { call } = boot();
    const res = await call<SessionResult>("session/load", { sessionId: "abc-123", cwd: "/w" });
    expect(res.sessionId).toBe("abc-123");
  });

  it("session/load refuses an id that is not a plain token", async () => {
    const { call } = boot();
    await expect(call("session/load", { sessionId: "../../escape", cwd: "/w" })).rejects.toThrow(
      /Некорректный id сессии/,
    );
  });

  it("rejects methods it does not implement", async () => {
    const { call } = boot();
    await expect(call("session/nope")).rejects.toThrow(/Unsupported method/);
  });

  it("turns down prompts before a session exists", async () => {
    const { call } = boot();
    await expect(
      call("session/prompt", { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(/session\/new/);
  });

  it("fails fast when the endpoint is not configured", async () => {
    const { call } = boot();
    await call("session/new", {});
    await expect(
      call("session/prompt", { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(/Не задан адрес/);
  });

  it("accepts session/set_mode for its own modes", async () => {
    const { call } = boot();
    await call("session/set_mode", { sessionId: "s", modeId: "plan" });
    await expect(call("session/set_mode", { sessionId: "s", modeId: "nope" })).resolves.toEqual({});
  });

  it("reports close exactly once", () => {
    const agent = boot();
    agent.close();
    agent.close();
    expect(agent.closes()).toBe(1);
    expect(agent.frames).toEqual([]);
  });
});

describe("builtin provider routing", () => {
  /** One recorded request against a stub OpenAI-compatible endpoint. */
  type Hit = { auth: string; model: string; sessionHeader: string };

  /** Minimal `/chat/completions` stub that streams one assistant sentence. */
  async function startStub(): Promise<{
    url: string;
    hits: Hit[];
    userContents: unknown[];
    close(): Promise<void>;
  }> {
    const hits: Hit[] = [];
    const userContents: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        const model =
          parsed && typeof parsed === "object" && "model" in parsed ? parsed.model : "";
        hits.push({
          auth: String(req.headers.authorization ?? ""),
          model: String(model ?? ""),
          sessionHeader: String(req.headers["x-opencode-session"] ?? ""),
        });
        const rawMessages =
          parsed && typeof parsed === "object" && "messages" in parsed ? parsed.messages : undefined;
        const messages = Array.isArray(rawMessages) ? rawMessages : [];
        const user = messages.find((m) => m?.role === "user");
        if (user) userContents.push(user.content);
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null },
            ],
          }),
        );
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    return {
      url: `http://127.0.0.1:${address.port}/v1`,
      hits,
      userContents,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("sends each turn to the endpoint that owns the selected model", async () => {
    const one = await startStub();
    const two = await startStub();
    try {
      const { call } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "First",
            url: one.url,
            apiKey: "sk-one",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
          {
            id: "p2",
            name: "Second",
            url: two.url,
            apiKey: "sk-two",
            models: [{ id: "m2", label: "M2", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      await call("session/set_config_option", { configId: "model", value: "p2::m2" });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(one.hits).toEqual([]);
      expect(two.hits).toEqual([{ auth: "Bearer sk-two", model: "m2", sessionHeader: "" }]);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it("resolves {{sessionId}} in the provider's extra headers to the session id", async () => {
    const stub = await startStub();
    try {
      const { call } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "OpenCode",
            url: stub.url,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            headers: [
              { name: "x-opencode-session", value: "{{sessionId}}" },
              { name: "x-static", value: "fixed" },
            ],
          },
        ],
      });
      const { sessionId } = await call<SessionResult>("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.hits).toEqual([
        { auth: "", model: "m1", sessionHeader: sessionId },
      ]);
    } finally {
      await stub.close();
    }
  });

  it("reports the endpoint's token split in usage_update", async () => {
    const stub = await startStub();
    try {
      const { call, frames } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Local",
            url: stub.url,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "hi" }],
      });
      // The stub answers with usage 1 in / 1 out / 2 total.
      const usage = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .find((update) => update?.sessionUpdate === "usage_update");
      expect(usage).toMatchObject({ used: 2, size: 8_000, inputTokens: 1, outputTokens: 1 });
    } finally {
      await stub.close();
    }
  });

  it("refuses to prompt when the selected model's provider lost its endpoint", async () => {
    const { call } = boot({
      builtinProviders: [
        {
          id: "p1",
          name: "Off",
          url: "",
          apiKey: "",
          models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
        },
      ],
    });
    await call("session/new", { cwd: "/w" });
    await expect(
      call("session/prompt", { prompt: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(/Не задан адрес/);
  });

  it("hands an attached image to the model as an inline image part", async () => {
    const stub = await startStub();
    const PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    try {
      const { call } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Local",
            url: stub.url,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [
          { type: "text", text: "что на картинке?" },
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(stub.userContents).toEqual([
        [
          { type: "text", text: "что на картинке?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      ]);
    } finally {
      await stub.close();
    }
  });
});

describe("builtin session store", () => {
  const sample = {
    version: 1 as const,
    cwd: "/w",
    modelId: "m1",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };

  it("round-trips a saved conversation", () => {
    const dir = tempDir();
    saveBuiltinSession(dir, "s-1", sample);
    expect(loadBuiltinSession(dir, "s-1")).toEqual(sample);
  });

  it("starts fresh on a corrupt file instead of throwing", () => {
    const dir = tempDir();
    saveBuiltinSession(dir, "s-1", sample);
    writeFileSync(join(dir, "s-1.json"), "{not json", "utf8");
    expect(loadBuiltinSession(dir, "s-1")).toBeUndefined();
  });

  it("never writes outside the state directory", () => {
    const dir = tempDir();
    expect(isValidSessionId("../../evil")).toBe(false);
    expect(isValidSessionId("01a0c607-8001-7768-844b-f0d6f97bd59e")).toBe(true);
    expect(() => saveBuiltinSession(dir, "../../evil", sample)).toThrow(/Некорректный id/);
    expect(loadBuiltinSession(dir, "../../evil")).toBeUndefined();
  });

  it("keeps image bytes only in the newest user turn", () => {
    const dir = tempDir();
    saveBuiltinSession(dir, "s-img", {
      version: 1,
      cwd: "/w",
      modelId: "m1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "вот скриншот" },
            { type: "file", mediaType: "image/png", data: "QUJD" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "вижу" }] },
        { role: "user", content: [{ type: "text", text: "а теперь?" }] },
      ],
    });
    expect(loadBuiltinSession(dir, "s-img")?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "вот скриншот" },
          { type: "text", text: "[изображение из предыдущего сообщения — не сохранено]" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "вижу" }] },
      { role: "user", content: [{ type: "text", text: "а теперь?" }] },
    ]);
  });
});
