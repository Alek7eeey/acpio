import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";
import { estimateTokens, promptView } from "./loop.js";
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

function boot(
  overrides: Partial<AppSettings> = {},
  stateDir = tempDir(),
  /** Answers the agent's own host calls (permissions, terminals, files). */
  answerHost?: (method: string, params: Record<string, unknown>) => unknown,
): Harness {
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
    // The agent's own host call: a request carries a method, a reply does not.
    // Both directions number their frames from 1, so the id cannot tell them
    // apart — the method can.
    if (typeof frame.method === "string") {
      if (answerHost) {
        agent.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: answerHost(frame.method, (frame.params ?? {}) as Record<string, unknown>) ?? {},
          }),
        );
      }
      return;
    }
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
    expect(model?.options).toEqual([
      { value: "p1::m1", name: "Model One", provider: "Test" },
    ]);
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
    /** Raw request bodies, for the wire parameters the agent chose itself. */
    bodies: Array<Record<string, unknown>>;
    userContents: unknown[];
    close(): Promise<void>;
  }> {
    const hits: Hit[] = [];
    const bodies: Array<Record<string, unknown>> = [];
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
        if (parsed && typeof parsed === "object") {
          bodies.push(parsed as Record<string, unknown>);
        }
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
      bodies,
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

  it("sends the configured output ceiling — and none when the setting says 0", async () => {
    const stub = await startStub();
    const provider = {
      id: "p1",
      name: "Test",
      url: stub.url,
      apiKey: "",
      models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
    };
    const ask = async (settings: Partial<AppSettings>) => {
      const { call } = boot({ builtinProviders: [provider], ...settings });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      return stub.bodies.at(-1) ?? {};
    };
    try {
      expect((await ask({ builtinMaxOutputTokens: 9_999 })).max_tokens).toBe(9_999);
      // 0 = "no ceiling": the key must not go out at all.
      expect("max_tokens" in (await ask({ builtinMaxOutputTokens: 0 }))).toBe(false);
      // Unset (an older stored payload) falls back to the documented default.
      expect((await ask({})).max_tokens).toBe(16_384);
    } finally {
      await stub.close();
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

  it("appends the user's extra instructions to the system prompt", async () => {
    const stub = await startStub();
    try {
      const { call } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Test",
            url: stub.url,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
        builtinExtraInstructions: "Think briefly, then answer.",
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      const messages = stub.bodies.at(-1)?.messages as Array<Record<string, unknown>>;
      expect(messages[0]?.role).toBe("system");
      expect(String(messages[0]?.content)).toContain("Think briefly, then answer.");
    } finally {
      await stub.close();
    }
  });

  it("merges the provider's extra request body into every call", async () => {
    const stub = await startStub();
    try {
      const { call } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "MiMo",
            url: stub.url,
            apiKey: "",
            models: [{ id: "mimo-v2.6-flash", label: "MiMo", contextWindow: 8_000 }],
            // The knob the OpenAI-compatible schema has no field for.
            body: '{"thinking":{"type":"disabled"}}',
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.bodies.at(-1)?.thinking).toEqual({ type: "disabled" });
      // The built body is left intact around the merge.
      expect(stub.bodies.at(-1)?.stream).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("offers Default/Low/Extra low per model and keeps the wire switch on /thinking", async () => {
    const stub = await startStub();
    const dir = tempDir();
    try {
      const { call, frames } = boot(
        {
          builtinProviders: [
            {
              id: "p1",
              name: "MiMo",
              url: stub.url,
              apiKey: "",
              models: [{ id: "mimo-v2.6-flash", label: "MiMo", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
      );
      const session = await call<SessionResult>("session/new", { cwd: "/w" });
      const thinking = session.configOptions.find((o) => o.id === "thinking");
      // The ⋯ menu shapes the prompt only — Off is not a mode any more.
      expect(thinking?.options?.map((o) => o.value)).toEqual(["default", "low", "extra-low"]);

      // The wire switch is a chat command, and the slash menu announces it.
      const commands = frames
        .map((f) => (f.params as { update?: Record<string, unknown> } | undefined)?.update)
        .find((u) => u?.sessionUpdate === "available_commands_update");
      expect((commands?.commands as Array<{ name: string }>).map((c) => c.name)).toContain(
        "thinking",
      );

      // Default: a plain request, nothing reasoning-related on the wire.
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.bodies.at(-1)?.thinking).toBeUndefined();

      // Low: the wire stays plain, but the budget rule rides the system prompt.
      await call("session/set_config_option", { configId: "thinking", value: "low" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      const low = stub.bodies.at(-1);
      expect(low?.thinking).toBeUndefined();
      expect(String((low?.messages as Array<Record<string, unknown>>)[0]?.content)).toContain(
        "private reasoning budget is 150 words",
      );

      // Extra low: the tighter per-step cap rides the same prompt slot.
      await call("session/set_config_option", { configId: "thinking", value: "extra-low" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      const extra = stub.bodies.at(-1);
      expect(extra?.thinking).toBeUndefined();
      expect(String((extra?.messages as Array<Record<string, unknown>>)[0]?.content)).toContain(
        "capped at 3 sentences per step",
      );
      expect(String((extra?.messages as Array<Record<string, unknown>>)[0]?.content)).not.toContain(
        "private reasoning budget is 150 words",
      );
      // Back to default: the prompt is clean of budget rules again.
      await call("session/set_config_option", { configId: "thinking", value: "default" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      const back = stub.bodies.at(-1);
      expect(String((back?.messages as Array<Record<string, unknown>>)[0]?.content)).not.toContain(
        "capped at 3 sentences per step",
      );

      // /thinking off flips the wire switch without calling the model.
      const before = stub.bodies.length;
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "/thinking off" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(stub.bodies.length).toBe(before);
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.bodies.at(-1)?.thinking).toEqual({ type: "disabled" });
      // A command is not a turn: it never enters the history the model reads.
      expect(JSON.stringify(stub.bodies.at(-1)?.messages)).not.toContain("/thinking");
      // And it outlives the process.
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingOff).toBe(true);

      // Bare /thinking toggles it back on.
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking" }] });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.bodies.at(-1)?.thinking).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it("restores the /thinking wire switch from the stored session", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "wire-1", {
      version: 1,
      cwd: "/w",
      modelId: "p1::m1",
      messages: [],
      thinkingOff: true,
    });
    try {
      const { call } = boot(
        {
          builtinProviders: [
            {
              id: "p1",
              name: "MiMo",
              url: stub.url,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
      );
      await call("session/load", { sessionId: "wire-1", cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.bodies.at(-1)?.thinking).toEqual({ type: "disabled" });
    } finally {
      await stub.close();
    }
  });

  it("arms /thinking-limit, cuts a runaway thinker and carries the turn on", async () => {
    // The fuse: a step that only thinks past the cap is cut mid-stream, the
    // thinking it produced is sent back with the reminder (the provider
    // requires reasoning_content back anyway), and the turn still answers.
    let requests = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests += 1;
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const delta = (d: Record<string, unknown>) =>
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: d, finish_reason: null }],
          });
        if (requests === 1) {
          // Runaway thinking: 10 × 100 chars = 1000 > the 500-char cap. The
          // client drops the connection mid-stream; the writes below land on
          // a dead socket and are ignored.
          for (let i = 0; i < 10; i += 1) {
            res.write(delta({ role: "assistant", reasoning_content: `${i}`.padEnd(100, ".") }));
          }
          res.end();
          return;
        }
        res.write(delta({ role: "assistant", content: "готово" }));
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
    const dir = tempDir();
    try {
      const { call, frames } = boot(
        {
          builtinProviders: [
            {
              id: "p1",
              name: "Stub",
              url: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
      );
      const session = await call<{ sessionId: string }>("session/new", { cwd: "/w" });

      // The command is offered next to /thinking.
      const commands = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .find((update) => update?.sessionUpdate === "available_commands_update");
      expect((commands?.commands as Array<{ name: string }>).map((c) => c.name)).toContain(
        "thinking-limit",
      );

      // Bare = report, off by default; on = the 3000-char default; 500 = ours.
      const chunkText = () =>
        frames
          .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
          .map((params) => params?.update)
          .filter((update) => update?.sessionUpdate === "agent_message_chunk")
          .map((update) => String((update?.content as { text?: unknown })?.text ?? ""))
          .join("");
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking-limit" }] });
      expect(chunkText()).toContain("Fuse is off");
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking-limit 500" }] });

      // The runaway step: cut at the cap, the turn carries on and answers.
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "сделай" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(requests).toBe(2);

      // The continuation request carries the cut thinking back...
      const continued = bodies[1].messages as Array<Record<string, unknown>>;
      const assistant = continued.find((m) => m.role === "assistant") as
        | { reasoning_content?: string }
        | undefined;
      expect(assistant?.reasoning_content ?? "").toContain("0....");
      // ...and the reminder, not the generic "continue".
      expect(JSON.stringify(continued.at(-1))).toContain("exceeded the 500-char limit");

      // The user sees the cut and the answer it freed.
      const text = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .filter((update) => update?.sessionUpdate === "agent_message_chunk")
        .map((update) => String((update?.content as { text?: unknown })?.text ?? ""))
        .join("");
      const thoughts = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .filter((update) => update?.sessionUpdate === "agent_thought_chunk")
        .map((update) => String((update?.content as { text?: unknown })?.text ?? ""))
        .join("");
      expect(thoughts).toContain("обрезаны по лимиту 500");
      expect(text).toContain("готово");
      expect(text).toContain("Fuse is on: a step's reasoning past 500");

      // The fuse outlives the process, like the wire switch.
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingLimit).toBe(500);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("arms the fuse from the global setting unless the chat overrides it", async () => {
    // The same runaway streamer, sized past the global 1200: this chat never
    // runs `/thinking-limit <n>`, so only the global setting can arm the fuse.
    let requests = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests += 1;
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const delta = (d: Record<string, unknown>) =>
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: d, finish_reason: null }],
          });
        if (requests === 1) {
          // 20 × 100 chars = 2000 > the global 1200-char cap.
          for (let i = 0; i < 20; i += 1) {
            res.write(delta({ role: "assistant", reasoning_content: `${i}`.padEnd(100, ".") }));
          }
          res.end();
          return;
        }
        res.write(delta({ role: "assistant", content: "готово" }));
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
    const dir = tempDir();
    try {
      const { call, frames } = boot(
        {
          builtinThinkingLimit: 1_200,
          builtinProviders: [
            {
              id: "p1",
              name: "Stub",
              url: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
      );
      const session = await call<{ sessionId: string }>("session/new", { cwd: "/w" });
      const chunks = () =>
        frames
          .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
          .map((params) => params?.update)
          .filter((update) => update?.sessionUpdate === "agent_message_chunk")
          .map((update) => String((update?.content as { text?: unknown })?.text ?? ""))
          .join("");

      // Bare report: the global setting already arms this chat, no command run.
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking-limit" }] });
      expect(chunks()).toContain("Fuse is on: a step's reasoning past 1200");
      expect(chunks()).toContain("The cap comes from the global setting.");
      // Reporting must not pin a per-chat override.
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingLimit).toBeUndefined();

      // The turn's fuse: the runaway step is cut at the global cap and the
      // reminder quotes it, although this chat never set a limit.
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "сделай" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(requests).toBe(2);
      const continued = bodies[1].messages as Array<Record<string, unknown>>;
      expect(JSON.stringify(continued.at(-1))).toContain("exceeded the 1200-char limit");
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingLimit).toBeUndefined();

      // Explicit off in the chat wins over the global setting...
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking-limit off" }] });
      expect(chunks()).toContain("Fuse is off");
      expect(chunks()).toContain("while the global setting is 1200 chars");
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingLimit).toBe(0);

      // ...and `on` hands control straight back to it.
      await call("session/prompt", { prompt: [{ type: "text", text: "/thinking-limit on" }] });
      expect(chunks()).toContain("Fuse is on: a step's reasoning past 1200");
      expect(loadBuiltinSession(dir, session.sessionId)?.thinkingLimit).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the provider's rejection when an extra header is wrong", async () => {
    const server = createServer((req, res) => {
      void req;
      res.setHeader("content-type", "application/json");
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: "unexpected x-opencode-session header" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    try {
      const { call } = boot({
        // The rejection is the subject here, not the retry ladder — cap the
        // attempts so the report lands before the backoff runs its course.
        builtinTurnRetryAttempts: 1,
        builtinProviders: [
          {
            id: "p1",
            name: "OpenCode",
            url: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            headers: [{ name: "x-opencode-session", value: "wrong" }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      await expect(
        call("session/prompt", { prompt: [{ type: "text", text: "hi" }] }),
      ).rejects.toThrow(/HTTP 401.*unexpected x-opencode-session header/s);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it("keeps the session's spend rows growing across steps, turns and a restart", async () => {
    // The panel's in/out/cached rows are the session's bill. They are stored as
    // the latest update, so a report scoped to whatever just happened — one
    // call, one turn, one pass — hands the reader a smaller number than the one
    // before it. This stub bills every model call differently, runs a two-step
    // turn and then a second one, and the session is reopened in between.
    const wire = { input: 0, output: 0, cached: 0 };
    const bills = [
      { input: 1_000, output: 10, cached: 800 },
      { input: 1_200, output: 20, cached: 900 },
      { input: 1_300, output: 5, cached: 1_000 },
      { input: 1_400, output: 7, cached: 1_100 },
    ];
    let requests = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        JSON.parse(body);
        const bill = bills[Math.min(requests, bills.length - 1)];
        requests += 1;
        wire.input += bill.input;
        wire.output += bill.output;
        wire.cached += bill.cached;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const usage = {
          prompt_tokens: bill.input,
          completion_tokens: bill.output,
          total_tokens: bill.input + bill.output,
          prompt_tokens_details: { cached_tokens: bill.cached },
        };
        if (requests === 1) {
          // Step one asks for a tool, so the turn spans two billed calls.
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: { name: "bash", arguments: '{"command":"echo hi"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage,
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "готово" }, finish_reason: null },
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
            usage,
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    const dir = tempDir();
    const settings = {
      builtinProviders: [
        {
          id: "p1",
          name: "Local",
          url: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "",
          models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
        },
      ],
    };
    const answerHost = (method: string): unknown => {
      if (method === "session/request_permission") {
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      }
      if (method === "terminal/create") return { terminalId: "t1" };
      if (method === "terminal/output") return { output: "hi\n" };
      return {};
    };
    /** Every spend row the agent put on the wire, in order. */
    const rows = (frames: Array<Record<string, unknown>>) =>
      frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .filter((update) => update?.sessionUpdate === "usage_update")
        .map((update) => ({
          input: Number(update?.inputTokens ?? 0),
          output: Number(update?.outputTokens ?? 0),
          cached: Number(update?.cachedInputTokens ?? 0),
        }));
    /** Rows never fall: each report may only add what it bills for the first time. */
    const expectGrowing = (all: Array<{ input: number; output: number; cached: number }>) => {
      for (let i = 1; i < all.length; i += 1) {
        for (const key of ["input", "output", "cached"] as const) {
          expect(`${key}[${i}]=${all[i][key]}`).toBe(
            `${key}[${i}]=${Math.max(all[i - 1][key], all[i][key])}`,
          );
        }
      }
    };
    try {
      const first = boot(settings, dir, answerHost);
      const session = await first.call<{ sessionId: string }>("session/new", { cwd: dir });
      // Turn one spans two model calls; turn two bills a third.
      await first.call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      await first.call("session/prompt", { prompt: [{ type: "text", text: "again" }] });
      const beforeRestart = rows(first.frames);
      expect(beforeRestart.length).toBeGreaterThan(1);
      expectGrowing(beforeRestart);
      // The rows are the bill: as much as the endpoint charged, no more —
      // two calls of the first turn plus the second turn's own.
      expect(beforeRestart.at(-1)).toEqual({ input: 3_500, output: 35, cached: 2_700 });
      expect(wire.input).toBe(3_500);

      // Restart: a restored session resumes its totals instead of starting the
      // panel over from what the very next call happens to cost.
      const second = boot(settings, dir, answerHost);
      await second.call("session/load", { sessionId: session.sessionId, cwd: dir });
      await second.call("session/prompt", { prompt: [{ type: "text", text: "hi again" }] });
      const afterRestart = rows(second.frames);
      expectGrowing([...beforeRestart, ...afterRestart]);
      expect(afterRestart.at(-1)).toEqual({ input: 4_900, output: 42, cached: 3_800 });
      expect(wire).toEqual({ input: 4_900, output: 42, cached: 3_800 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reruns the turn when the provider stream dies mid-flight", async () => {
    // First request: response head + one delta, then the socket is cut — the
    // failure shape a flaky gateway produces. The SDK does not retry a stream
    // that already started, so this exercises the adapter's own turn retry.
    let hits = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        hits += 1;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
            ],
          }),
        );
        if (hits === 1) {
          setTimeout(() => res.destroy(), 50);
          return;
        }
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
    try {
      const { call, frames } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Flaky",
            url: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(hits).toBe(2);
      const updates = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update);
      expect(
        updates.some(
          (update) =>
            update?.sessionUpdate === "agent_thought_chunk" &&
            JSON.stringify(update).includes("повторяю ход"),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("carries the turn on when the model stops without answering", async () => {
    // The report: a step ended on reasoning alone — no text, no tool call, so
    // nothing the turn or the reader could act on — and there the whole turn
    // ended. The chat fell silent with the work unfinished and the user had to
    // type "продолжай" to get the answer. A step the model never finished is not
    // an answer: the turn runs on from what it produced.
    let requests = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests += 1;
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const delta = (d: Record<string, unknown>) =>
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: d, finish_reason: null }],
          });
        // The first call only thinks; the second one is the continuation the
        // adapter has to ask for.
        res.write(
          delta(
            requests === 1
              ? { role: "assistant", reasoning_content: "надо подумать" }
              : { role: "assistant", content: "готово" },
          ),
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
    try {
      const { call, frames } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Stub",
            url: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "сделай" }],
      });
      expect(res.stopReason).toBe("end_turn");

      // The turn reached an answer instead of ending on the cut step...
      expect(requests).toBe(2);
      const updates = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update);
      const answer = updates
        .filter((update) => update?.sessionUpdate === "agent_message_chunk")
        .map((update) => String((update?.content as { text?: unknown })?.text ?? ""))
        .join("");
      expect(answer).toContain("готово");

      // ...and the model was told where to pick up, right after its cut step
      // (the default locale; the ru wording is the same line in Russian).
      const messages = bodies[1].messages as Array<Record<string, unknown>>;
      expect(JSON.stringify(messages.at(-1))).toContain("Continue from where you stopped");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds the continuations of a model that never answers", async () => {
    // A model stuck in a degenerate loop must not be able to spin the harness
    // forever: after the last continuation the turn ends the way it always did,
    // and the server's "no answer" notice is what the user gets.
    let requests = 0;
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        requests += 1;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", reasoning_content: "думаю" }, finish_reason: null },
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
    try {
      const { call, frames } = boot({
        builtinProviders: [
          {
            id: "p1",
            name: "Stub",
            url: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
      });
      await call("session/new", { cwd: "/w" });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "сделай" }],
      });
      expect(res.stopReason).toBe("end_turn");
      // One call, then the continuation budget: no more.
      expect(requests).toBe(3);
      const updates = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update);
      expect(
        updates.some(
          (update) =>
            update?.sessionUpdate === "agent_thought_chunk" &&
            JSON.stringify(update).includes("оборвался"),
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("finishes a turn the gateway rejected mid-turn instead of dropping it", async () => {
    // The incident this guards: a tool step completed, the next model call was
    // answered with HTTP 400 ("reasoning_content must be passed back"), and the
    // turn — messages already produced, so no exception to catch — was handed
    // back as failed and the chat stopped there. The adapter must re-issue the
    // call and carry the turn to its end.
    let requests = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests += 1;
        if (requests === 2) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
              },
            }),
          );
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        if (requests === 1) {
          // Step one asks for a tool, so the turn is mid-flight when step two
          // is rejected — that is the shape that used to end the chat.
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-1",
                        type: "function",
                        function: { name: "bash", arguments: '{"command":"echo hi"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "готово" }, finish_reason: null },
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
    const dir = tempDir();
    try {
      const { call, frames } = boot(
        {
          builtinProviders: [
            {
              id: "p1",
              name: "Flaky",
              url: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
        (method) => {
          if (method === "session/request_permission") {
            return { outcome: { outcome: "selected", optionId: "allow_once" } };
          }
          if (method === "terminal/create") return { terminalId: "t1" };
          if (method === "terminal/output") return { output: "hi\n" };
          return {};
        },
      );
      const session = await call<{ sessionId: string }>("session/new", { cwd: dir });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(res.stopReason).toBe("end_turn");
      // The rejected call was made again: one tool step, the 400, the retry.
      expect(requests).toBe(3);
      const updates = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update);
      expect(
        updates.some(
          (update) =>
            update?.sessionUpdate === "agent_thought_chunk" &&
            JSON.stringify(update).includes("повторяю ход"),
        ),
      ).toBe(true);
      // The work the dead attempt produced is kept — exactly once: the tool
      // step lives on and the retry continues from it.
      const stored = JSON.stringify(loadBuiltinSession(dir, session.sessionId));
      expect(stored.match(/"type":"tool-call"/g)).toHaveLength(1);
      expect(stored.match(/"type":"tool-result"/g)).toHaveLength(1);
      expect(stored).toContain("готово");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("asks the user through the harness and carries the answer into the turn", async () => {
    const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
    let requests = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests += 1;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        if (requests === 1) {
          // The model's first step is the question, so the card is what makes
          // the turn continue — everything after it rides on the answer.
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-q",
                        type: "function",
                        function: {
                          name: "ask",
                          arguments: JSON.stringify({
                            questions: [
                              {
                                id: "target",
                                question: "Куда положить модуль?",
                                options: [{ id: "api", label: "src/api" }],
                              },
                            ],
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
          res.write(
            chunk({
              id: "c1",
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "кладу в src/api" }, finish_reason: null },
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
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    const dir = tempDir();
    try {
      const { call } = boot(
        {
          builtinProviders: [
            {
              id: "p1",
              name: "Stub",
              url: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
        dir,
        (method, params) => {
          if (method === "elicitation/create") {
            asked.push({ method, params });
            return { action: "accept", content: { target: "src/api" } };
          }
          return {};
        },
      );
      const session = await call<{ sessionId: string }>("session/new", { cwd: dir });
      const res = await call<{ stopReason: string }>("session/prompt", {
        prompt: [{ type: "text", text: "переделай модуль" }],
      });
      expect(res.stopReason).toBe("end_turn");
      expect(asked).toHaveLength(1);
      expect(asked[0]!.params.sessionId).toBe(session.sessionId);
      expect(asked[0]!.params.mode).toBe("form");
      expect(asked[0]!.params.requestedSchema).toEqual({
        type: "object",
        properties: {
          target: {
            type: "string",
            title: "Куда положить модуль?",
            oneOf: [{ const: "api", title: "src/api" }],
          },
          target__other: { type: "string", title: "Other" },
        },
        required: ["target"],
      });
      // The answer is what the second model call was given, and what the chat
      // keeps: one tool step, then the answer the model acted on.
      const stored = JSON.stringify(loadBuiltinSession(dir, session.sessionId));
      expect(stored).toContain("The user answered");
      expect(stored).toContain("src/api");
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

describe("compaction reporting", () => {
  /** The provider stub from the routing suite, one sentence per call. */
  async function startStub(): Promise<{
    url: string;
    /** Raw request bodies, in the order the provider saw them. */
    bodies: Array<Record<string, unknown>>;
    close(): Promise<void>;
  }> {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        bodies.push(parsed);
        const streaming = Boolean(parsed.stream);
        // The turn streams; the digest pass (`generateText`) asks for a plain
        // JSON completion — answer each in the shape it asked for.
        if (!streaming) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              id: "c1",
              object: "chat.completion",
              created: 0,
              model: "stub",
              choices: [
                { index: 0, message: { role: "assistant", content: "конспект" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              { index: 0, delta: { role: "assistant", content: "конспект" }, finish_reason: null },
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
      bodies,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const provider = (url: string, contextWindow = 8_000) => ({
    id: "p1",
    name: "Test",
    url,
    apiKey: "",
    models: [{ id: "m1", label: "M1", contextWindow }],
  });

  /**
   * History over the trigger line — and made of turns small enough relative to
   * the window that a digest can keep a tail: one 10k-char turn per window
   * slice leaves no cut at all, which tests the fixture instead of the pass.
   * 80% of an 8k window ≈ 32k chars; 12 turns × 2.5k ≈ 30k.
   */
  const bulky = (turns = 12, size = 2_500) =>
    Array.from({ length: turns }, (_, i) => [
      { role: "user" as const, content: `ход ${i}: ${'д'.repeat(size)}` },
      { role: "assistant" as const, content: "принято" },
    ]).flat();

  /**
   * Turns after a folded prefix: one big step and one small one, so the cut
   * search has a boundary to walk to and the digested view stays measurable.
   */
  const tail = (big: number) => [
    { role: "user" as const, content: `шаг: ${"д".repeat(big)}` },
    { role: "assistant" as const, content: "сделано" },
    { role: "user" as const, content: "проверь" },
    { role: "assistant" as const, content: "готово" },
  ];

  /** Every compaction update the agent put on the wire, in order. */
  const compactionRows = (frames: Array<Record<string, unknown>>) =>
    frames
      .map((frame) => (frame.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((update): update is Record<string, unknown> => update?.sessionUpdate === "compaction");

  const textChunks = (frames: Array<Record<string, unknown>>) =>
    frames
      .map((frame) => (frame.params as { update?: Record<string, unknown> } | undefined)?.update)
      .filter((update) => update?.sessionUpdate === "agent_message_chunk");

  it("reports an automatic pass with the digest and both window sizes", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "long-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: bulky(),
    });
    try {
      const { call, frames } = boot(
        { builtinProviders: [provider(stub.url)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "long-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "продолжай" }] });

      const row = compactionRows(frames).at(-1);
      expect(row).toBeTruthy();
      expect(row?.manual).toBe(false);
      expect(row?.summary).toBe("конспект");
      expect(Number(row?.coveredAfter)).toBeGreaterThan(Number(row?.coveredBefore));
      expect(Number(row?.tokensAfter)).toBeLessThan(Number(row?.tokensBefore));
    } finally {
      await stub.close();
    }
  });

  it("marks a `/compact` pass as manual and answers with the row alone", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "long-2", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: bulky(),
    });
    try {
      const { call, frames } = boot(
        { builtinProviders: [provider(stub.url)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "long-2", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "/compact" }] });

      const row = compactionRows(frames).at(-1);
      expect(row?.manual).toBe(true);
      expect(row?.summary).toBe("конспект");
      expect(Number(row?.coveredAfter)).toBeGreaterThan(Number(row?.coveredBefore));
      // The row carries the report: no "Конспект обновлён" wall of text next to it.
      expect(textChunks(frames)).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("still answers `/compact` in words when there is nothing to fold", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "short-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: [{ role: "user", content: "привет" }],
    });
    try {
      const { call, frames } = boot(
        { builtinProviders: [provider(stub.url)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "short-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "/compact" }] });

      expect(compactionRows(frames)).toEqual([]);
      expect(JSON.stringify(textChunks(frames))).toContain("Сжимать нечего");
    } finally {
      await stub.close();
    }
  });

  it("does not run a pass the digested view does not need, however big the stored history", async () => {
    const stub = await startStub();
    const dir = tempDir();
    const prefix = bulky(); // ~30k chars ≈ 7.5k tokens — over the 80% line of an 8k window
    const compaction = { summary: "прежний конспект", covered: prefix.length };
    saveBuiltinSession(dir, "dig-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: [...prefix, ...tail(8_000)],
      compaction,
    });
    try {
      const { call, frames } = boot(
        { builtinProviders: [provider(stub.url)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "dig-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "продолжай" }] });

      // The stored file is far over the line, but the digest already stands in
      // for the bulky part and digest + tail fits — nothing to squeeze, so the
      // row must not appear at all (and no summariser call is paid for it).
      expect(compactionRows(frames)).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("reports the before size of the view the pass started from, not the stored history", async () => {
    const stub = await startStub();
    const dir = tempDir();
    const prefix = bulky();
    const compaction = { summary: "прежний конспект", covered: prefix.length };
    const messages = [...prefix, ...tail(28_000)]; // digest + tail crosses the line
    saveBuiltinSession(dir, "dig-2", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages,
      compaction,
    });
    try {
      const { call, frames } = boot(
        { builtinProviders: [provider(stub.url)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "dig-2", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "продолжай" }] });

      const row = compactionRows(frames).at(-1);
      expect(row).toBeTruthy();
      expect(row?.manual).toBe(false);
      const before = Number(row?.tokensBefore);
      // The row's base is never the raw transcript counting the already-folded
      // prefix again — that is the "1.3M tokens" figure no window ever
      // carried — but the digested view this pass started from (plus this
      // prompt), which is what the request would really have sent.
      expect(before).toBeLessThan(estimateTokens(messages));
      expect(before).toBeGreaterThanOrEqual(estimateTokens(promptView(messages, compaction)));
      expect(Number(row?.tokensAfter)).toBeLessThan(before);
    } finally {
      await stub.close();
    }
  });

  /**
   * The digest pass sends the turns it folds as the *same* messages the turn
   * just sent, with the instruction appended: its request is then a prefix of
   * the previous one, and a provider that caches prefixes charges only the
   * instruction. Flattening the head into a transcript of its own would share
   * nothing with that request and pay full price for tens of thousands of
   * tokens — exactly the cost the rolling `update` exists to avoid.
   */
  const sentMessages = (body: Record<string, unknown>) =>
    body.messages as Array<Record<string, unknown>>;

  it("asks the summariser over the prefix the previous turn already sent", async () => {
    const stub = await startStub();
    const dir = tempDir();
    // A window wide enough that the loaded history stays under the line: the
    // first turn must send a plain request, and only `/compact` then folds.
    saveBuiltinSession(dir, "warm-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: bulky(),
    });
    try {
      const { call } = boot(
        { builtinProviders: [provider(stub.url, 20_000)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "warm-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "привет" }] });
      const turn = stub.bodies.at(-1)!;
      expect(turn.stream).toBe(true);

      await call("session/prompt", { prompt: [{ type: "text", text: "/compact" }] });
      const summary = stub.bodies.at(-1)!;
      // The digest pass is a plain completion, not a streamed turn.
      expect(summary.stream).not.toBe(true);

      const sent = sentMessages(summary);
      const prev = sentMessages(turn);
      expect(sent.length).toBeLessThan(prev.length);
      // Byte for byte the same tokens from the first one: cache hit.
      expect(sent.slice(0, -1)).toEqual(prev.slice(0, sent.length - 1));
      // The tool declarations are rendered ahead of the messages, so they are
      // part of that prefix: a summary sent without them shares nothing with
      // the turn's request and the whole head is billed again.
      expect(summary.tools).toEqual(turn.tools);
      expect(summary.tools).toBeTruthy();
      expect(String(sent.at(-1)?.content)).toContain("Не отвечай на переписку выше");
    } finally {
      await stub.close();
    }
  });

  it("keeps the carried digest as the head of the pass's own request", async () => {
    const stub = await startStub();
    const dir = tempDir();
    const prefix = bulky();
    saveBuiltinSession(dir, "warm-2", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: [...prefix, ...tail(20_000)],
      compaction: { summary: "прежний конспект", covered: prefix.length },
    });
    try {
      const { call } = boot(
        { builtinProviders: [provider(stub.url, 20_000)], locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "warm-2", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "продолжай" }] });
      const turn = stub.bodies.at(-1)!;

      await call("session/prompt", { prompt: [{ type: "text", text: "/compact" }] });
      const sent = sentMessages(stub.bodies.at(-1)!);
      const prev = sentMessages(turn);
      expect(sent.length).toBeLessThan(prev.length);
      expect(sent.slice(0, -1)).toEqual(prev.slice(0, sent.length - 1));
      // The rolling pass reads the digest the previous request carried — same
      // bytes, so the head of that request stays cacheable.
      expect(String(sent[1]?.content)).toBe(String(prev[1]?.content));
      expect(String(sent[1]?.content)).toContain("прежний конспект");
    } finally {
      await stub.close();
    }
  });

  /**
   * A re-readable result the notes can replace, with `tail` exchanges after it
   * so it falls outside the verbatim end the mask always keeps.
   */
  const readStep = (chars: number, tail: number) => [
    { role: "user" as const, content: "прочитай файл" },
    {
      role: "assistant" as const,
      content: [
        { type: "tool-call" as const, toolCallId: "c1", toolName: "read", input: { path: "src/loop.ts" } },
      ],
    },
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "c1",
          toolName: "read",
          output: { type: "text" as const, value: "д".repeat(chars) },
        },
      ],
    },
    ...Array.from({ length: tail }, (_, i) => [
      { role: "user" as const, content: `дальше ${i}` },
      { role: "assistant" as const, content: "ок" },
    ]).flat(),
  ];
  const NOTE = "[output dropped to free room";

  it("sends the notes in the same turn as the pass that moved their boundary", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "notes-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: [...bulky(), ...readStep(4_000, 3)],
    });
    try {
      const { call } = boot({ builtinProviders: [provider(stub.url)], locale: "ru" }, dir);
      await call("session/load", { sessionId: "notes-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "привет" }] });
      const pass = stub.bodies.at(-1)!;
      expect(JSON.stringify(pass.messages)).toContain("дальше 0");
      // The boundary moved with this very pass, so the view going out now
      // already carries the note instead of the bytes.
      expect(JSON.stringify(pass.messages)).toContain(NOTE);

      await call("session/prompt", { prompt: [{ type: "text", text: "дальше" }] });
      const next = sentMessages(stub.bodies.at(-1)!);
      const prev = sentMessages(pass);
      // And the next turn only appends — the whole pass view comes from cache.
      expect(next.slice(0, prev.length)).toEqual(prev);
    } finally {
      await stub.close();
    }
  });

  it("keeps the notes across a restart", async () => {
    const stub = await startStub();
    const dir = tempDir();
    const messages = [...bulky(), ...readStep(4_000, 3)];
    // A boundary a previous pass left behind: without it the mask starts at
    // zero and every already-noted result rides back into the request.
    saveBuiltinSession(dir, "notes-2", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages,
      maskUpTo: messages.length - 3,
    });
    try {
      // A window wide enough that nothing is folded: the note can only come
      // from the restored boundary.
      const { call } = boot({ builtinProviders: [provider(stub.url, 20_000)], locale: "ru" }, dir);
      await call("session/load", { sessionId: "notes-2", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "продолжай" }] });
      expect(JSON.stringify(stub.bodies.at(-1)?.messages)).toContain(NOTE);
    } finally {
      await stub.close();
    }
  });

  /** Turns whose every step is a re-readable result — what the notes can free. */
  const reads = (count: number, chars: number) =>
    Array.from({ length: count }, (_, i) => [
      { role: "user" as const, content: `прочитай ${i}` },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `c${i}`,
            toolName: "read",
            input: { path: `f${i}.ts` },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: `c${i}`,
            toolName: "read",
            output: { type: "text" as const, value: "д".repeat(chars) },
          },
        ],
      },
    ]).flat();

  it("keeps the prune mode cut sticky so a quiet turn rides the cache", async () => {
    const stub = await startStub();
    const dir = tempDir();
    saveBuiltinSession(dir, "prune-1", {
      version: 1,
      cwd: dir,
      modelId: "p1::m1",
      messages: reads(6, 4_000),
    });
    try {
      // A window small against `bulky()`: the cut lands inside the history and,
      // recomputed every turn, would shift forward with each new exchange.
      const { call } = boot(
        { builtinProviders: [provider(stub.url, 3_000)], builtinContextMode: "prune", locale: "ru" },
        dir,
      );
      await call("session/load", { sessionId: "prune-1", cwd: dir });
      await call("session/prompt", { prompt: [{ type: "text", text: "раз" }] });
      const cut = sentMessages(stub.bodies.at(-1)!);
      // The head is dropped, and what is left starts at a turn boundary.
      expect(cut.length).toBeLessThan(reads(6, 4_000).length);
      expect(String(cut[0]?.content)).not.toContain("прочитай 0");

      await call("session/prompt", { prompt: [{ type: "text", text: "два" }] });
      const next = sentMessages(stub.bodies.at(-1)!);
      // The cut is recomputed only when the view outgrows the line, so this
      // turn appends to the previous request instead of rewriting it.
      expect(next.slice(0, cut.length)).toEqual(cut);
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

describe("builtin subagents wiring", () => {
  /** One scripted streaming reply: the delta to send and the finish reason. */
  type StubReply = { delta: Record<string, unknown>; finishReason: string };
  const TEXT_REPLY: StubReply = {
    delta: { role: "assistant", content: "ok" },
    finishReason: "stop",
  };

  /**
   * Like the routing stub, but records the system prompt, the offered tools and
   * the wire model. `script` answers request #n: a spawn test needs the first
   * reply to be a tool call, then the child's own reply, then the parent's close.
   */
  async function startRecordingStub(
    script: StubReply[] = [],
  ): Promise<{
    url: string;
    hits: Array<{ system: string; toolNames: string[]; model: string; messages: number }>;
    close(): Promise<void>;
  }> {
    const hits: Array<{ system: string; toolNames: string[]; model: string; messages: number }> =
      [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        const record = parsed && typeof parsed === "object" ? parsed : {};
        const rawTools = (record as { tools?: unknown }).tools;
        const messages = Array.isArray((record as { messages?: unknown }).messages)
          ? ((record as { messages: Array<Record<string, unknown>> }).messages)
          : [];
        const systemMessage = messages.find((m) => m?.role === "system");
        const reply = script[hits.length] ?? TEXT_REPLY;
        hits.push({
          system: String(
            systemMessage
              ? String(
                  (systemMessage.content as { text?: unknown } | undefined)?.text ??
                    systemMessage.content ??
                    "",
                )
              : "",
          ),
          // OpenAI wire format: [{ type: "function", function: { name } }].
          toolNames: Array.isArray(rawTools)
            ? rawTools.map((t) =>
                String(
                  (t as { function?: { name?: unknown } })?.function?.name ??
                    (t as { name?: unknown })?.name ??
                    "",
                ),
              )
            : [],
          model: String((record as { model?: unknown }).model ?? ""),
          messages: messages.length,
        });
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: reply.delta, finish_reason: null }],
          }),
        );
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason }],
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
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const provider = (url: string) => [
    {
      id: "p1",
      name: "Test",
      url,
      apiKey: "",
      models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
    },
  ];

  it("offers the task tool, and the system prompt stays lean, when the feature is on", async () => {
    const stub = await startRecordingStub();
    try {
      const { call } = boot({
        builtinProviders: provider(stub.url),
        builtinSubagents: { enabled: true, allowAdhoc: false, agents: [] },
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.hits).toHaveLength(1);
      expect(stub.hits[0]!.toolNames).toContain("task");
      // Subagents are advertised only through the tool description — the
      // standing cost of the feature is the tool, not prompt prose.
      expect(stub.hits[0]!.system).not.toContain("Subagents:");
    } finally {
      await stub.close();
    }
  });

  it("offers neither the tool nor any subagent wording when the feature is off", async () => {
    const stub = await startRecordingStub();
    try {
      const { call } = boot({ builtinProviders: provider(stub.url) });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "hi" }] });
      expect(stub.hits[0]!.toolNames).not.toContain("task");
      expect(stub.hits[0]!.system).not.toContain("Subagents:");
    } finally {
      await stub.close();
    }
  });

  /** Request #1 spawns `explore`, #2 is the child's own call, #3 closes the turn. */
  const SPAWN_SCRIPT: StubReply[] = [
    {
      delta: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({ agent: "explore", prompt: "find the bug" }),
            },
          },
        ],
      },
      finishReason: "tool_calls",
    },
    { delta: { role: "assistant", content: "child report" }, finishReason: "stop" },
    { delta: { role: "assistant", content: "done" }, finishReason: "stop" },
  ];

  const providersWithTwoModels = (url: string) => [
    {
      id: "p1",
      name: "Test",
      url,
      apiKey: "",
      models: [
        { id: "m1", label: "M1", contextWindow: 8_000 },
        { id: "m2", label: "M2", contextWindow: 32_000 },
      ],
    },
  ];

  it("runs children on the configured subagent model and the parent on its own", async () => {
    const stub = await startRecordingStub(SPAWN_SCRIPT);
    try {
      const { call } = boot({
        builtinProviders: providersWithTwoModels(stub.url),
        builtinSubagents: { enabled: true, allowAdhoc: false, agents: [], model: "p1::m2" },
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "go" }] });
      expect(stub.hits.map((h) => h.model)).toEqual(["m1", "m2", "m1"]);
      // The middle call is the child: its own explorer system prompt, fresh context.
      expect(stub.hits[1]!.system).toContain("codebase explorer");
      expect(stub.hits[1]!.messages).toBe(2);
    } finally {
      await stub.close();
    }
  });

  it("inherits the session model for children when no subagent model is set", async () => {
    const stub = await startRecordingStub(SPAWN_SCRIPT);
    try {
      const { call } = boot({
        builtinProviders: providersWithTwoModels(stub.url),
        builtinSubagents: { enabled: true, allowAdhoc: false, agents: [] },
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "go" }] });
      expect(stub.hits.map((h) => h.model)).toEqual(["m1", "m1", "m1"]);
    } finally {
      await stub.close();
    }
  });

  it("bills the child's spend into the session's rows exactly once", async () => {
    // Three billed calls on the wire — the parent's spawn, the child's own
    // answer, the parent's close. The rows are that bill and nothing else: the
    // child's spend joins the totals where the parent reports next, once, and
    // no update ever hands back what an earlier one showed.
    const stub = await startRecordingStub(SPAWN_SCRIPT);
    try {
      const { call, frames } = boot({
        builtinProviders: providersWithTwoModels(stub.url),
        builtinSubagents: { enabled: true, allowAdhoc: false, agents: [] },
      });
      await call("session/new", { cwd: "/w" });
      await call("session/prompt", { prompt: [{ type: "text", text: "go" }] });
      const rows = frames
        .map((frame) => frame.params as { update?: Record<string, unknown> } | undefined)
        .map((params) => params?.update)
        .filter((update) => update?.sessionUpdate === "usage_update")
        .map((update) => ({
          input: Number(update?.inputTokens ?? 0),
          output: Number(update?.outputTokens ?? 0),
        }));
      expect(rows.length).toBeGreaterThan(1);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.input).toBeGreaterThanOrEqual(rows[i - 1]!.input);
        expect(rows[i]!.output).toBeGreaterThanOrEqual(rows[i - 1]!.output);
      }
      expect(rows.at(-1)).toEqual({ input: 3, output: 3 });
      expect(stub.hits).toHaveLength(3);
    } finally {
      await stub.close();
    }
  });
});
