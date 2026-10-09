// Model-written chat titles: what the endpoint call sends and what of the
// answer survives, plus the DB write that must not clobber a hand rename.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { DEFAULT_SETTINGS, builtinModelValue, type AppSettings } from "@acpio/shared";
import { ensureSchema } from "../db/ensureSchema.js";
import { createSession, getSessionTitle, updateSession } from "./sessions.js";
import { generateChatTitle, refineSessionTitle } from "./chatTitle.js";

/** Bound TCP port of a listening server (fails the test otherwise). */
function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

let server: http.Server;
let base = "";
/** The last /chat/completions request body, for model/header assertions. */
let lastBody: Record<string, unknown> & { model?: string } | null = null;
let lastHeaders: http.IncomingHttpHeaders = {};
/** How many /chat/completions calls arrived — how many tries a call took. */
let requestCount = 0;
/** Per-request overrides, one entry per call, to script a failing first try. */
let steps: { status?: number; delayMs?: number }[] = [];
/** What the stub answers — override per test. */
let reply: { status: number; content: unknown } = { status: 200, content: "plain title" };
/** Set to delay the answer so a rename can land mid-flight. */
let delayMs = 0;

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, chatAutoTitle: true, ...overrides };
}

function provider(id: string, url: string, models: string[]) {
  return {
    id,
    name: id,
    url,
    apiKey: "",
    models: models.map((m) => ({ id: m, label: m, contextWindow: 8_000 })),
  };
}

beforeAll(async () => {
  await ensureSchema();
  server = http.createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    lastHeaders = req.headers;
    requestCount++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        lastBody = null;
      }
      const step = steps.shift();
      const answer = () => {
        if (res.destroyed) return; // the caller timed out and walked away
        res.statusCode = step?.status ?? reply.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
      };
      const wait = step?.delayMs ?? delayMs;
      if (wait) setTimeout(answer, wait);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  lastBody = null;
  lastHeaders = {};
  requestCount = 0;
  steps = [];
  reply = { status: 200, content: "plain title" };
  delayMs = 0;
});

afterEach(() => {
  delayMs = 0;
});

describe("generateChatTitle", () => {
  it("cleans the answer: first line, unwrapped, capped at the title length", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: `«Заголовок со\nвторой строкой, которую не видно»` };
    const title = await generateChatTitle(settings, "почини баг с рендером");
    expect(title).toBe("Заголовок со");
  });

  it("truncates an over-long answer to the title cap", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: "Очень длинное название задачи ".repeat(10) };
    const title = await generateChatTitle(settings, "источник");
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(80);
    expect(title!.endsWith("…")).toBe(true);
  });

  it("sends the source and a one-line-only instruction", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    await generateChatTitle(settings, "первая строка\nвторая строка");
    expect(lastBody?.model).toBe("m");
    const messages = (lastBody as { messages?: { role: string; content: string }[] }).messages;
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.at(-1)?.content).toContain("первая строка");
    // The whole raw message is handed over: the model picks what to title by,
    // not a local first-line slice.
    expect(messages?.at(-1)?.content).toContain("вторая строка");
  });

  it("frames the source as data to title, not as a turn to answer", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    await generateChatTitle(
      settings,
      'посмотри на чат "Сжатие промпта" причина почему он остановился?',
    );
    const messages = (lastBody as { messages?: { role: string; content: string }[] }).messages!;
    // The instruction must tell the model the source is not addressed to it.
    expect(messages[0].content).toMatch(/не отвечай|do not answer/i);
    // …and the source must arrive wrapped as a quoted block, never bare.
    expect(messages.at(-1)!.content).toMatch(/^<<<\n[\s\S]*\n>>>$/);
  });

  it("takes only a title: an answer to the source is discarded", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = {
      status: 200,
      content:
        "Я не имею доступа к другим чатам — вижу только этот разговор. Чтобы я мог помочь, скажите, какой чат открыть.",
    };
    expect(await generateChatTitle(settings, "посмотри на чат ...")).toBeNull();
    reply = { status: 200, content: "Я не вижу других чатов." };
    expect(await generateChatTitle(settings, "посмотри на чат ...")).toBeNull();
  });

  it("retries once when the first answer arrives past the timeout", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    steps = [{ delayMs: 120 }];
    const title = await generateChatTitle(settings, "источник", undefined, {
      timeoutMs: 50,
      retryDelayMs: 10,
    });
    expect(title).toBe("plain title");
    expect(requestCount).toBe(2);
  });

  it("retries once after a server error, gives up after the second", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    steps = [{ status: 500 }];
    expect(await generateChatTitle(settings, "источник", undefined, { retryDelayMs: 10 })).toBe(
      "plain title",
    );
    expect(requestCount).toBe(2);

    steps = [{ status: 500 }, { status: 500 }];
    expect(await generateChatTitle(settings, "источник", undefined, { retryDelayMs: 10 })).toBeNull();
    expect(requestCount).toBe(4);
  });

  it("does not retry a request the endpoint rejects outright", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    steps = [{ status: 400 }];
    expect(await generateChatTitle(settings, "x", undefined, { retryDelayMs: 10 })).toBeNull();
    expect(requestCount).toBe(1);
  });

  it("picks the first configured model when the setting is auto", async () => {
    const settings = settingsWith({
      builtinProviders: [
        provider("a", base, ["a1", "a2"]),
        provider("b", base, ["b1"]),
      ],
      chatTitleModel: "auto",
    });
    await generateChatTitle(settings, "источник");
    expect(lastBody?.model).toBe("a1");
  });

  it("picks the configured model, not the first one", async () => {
    const settings = settingsWith({
      builtinProviders: [provider("a", base, ["a1", "a2"]), provider("b", base, ["b1"])],
      chatTitleModel: builtinModelValue("b", "b1"),
    });
    await generateChatTitle(settings, "источник");
    expect(lastBody?.model).toBe("b1");
  });

  it("keeps no provider rows / no endpoint at all as null without a request", async () => {
    expect(await generateChatTitle(settingsWith({ builtinProviders: [] }), "x")).toBeNull();
    // A provider whose URL is empty can answer nothing.
    expect(
      await generateChatTitle(settingsWith({ builtinProviders: [provider("p", "", ["m"])] }), "x"),
    ).toBeNull();
    expect(lastBody).toBeNull();
  });

  it("stays null on a non-200, on garbage, and on an empty answer", async () => {
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 500, content: "boom" };
    expect(await generateChatTitle(settings, "x")).toBeNull();
    reply = { status: 200, content: null };
    expect(await generateChatTitle(settings, "x")).toBeNull();
    reply = { status: 200, content: "   \n  " };
    expect(await generateChatTitle(settings, "x")).toBeNull();
  });

  it("substitutes {{sessionId}} in provider headers", async () => {
    const settings = settingsWith({
      builtinProviders: [
        {
          ...provider("p", base, ["m"]),
          headers: [{ name: "X-Session", value: "{{sessionId}}" }],
        },
      ],
    });
    await generateChatTitle(settings, "x", "session-42");
    expect(lastHeaders["x-session"]).toBe("session-42");
  });
});

describe("refineSessionTitle", () => {
  async function newChat(title?: string) {
    const session = await createSession({ provider: "omp", cwd: "/w", mode: "agent", title });
    return session.id;
  }

  it("rewrites an auto-derived title with the model answer", async () => {
    const id = await newChat("первое сообщение");
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: "Красивая задача" };
    await refineSessionTitle(id, "источник", settings);
    expect(await getSessionTitle(id)).toBe("Красивая задача");
  });

  it("keeps the title when the feature is off — no request is made", async () => {
    const id = await newChat("как было");
    const settings = settingsWith({
      chatAutoTitle: false,
      builtinProviders: [provider("p", base, ["m"])],
    });
    await refineSessionTitle(id, "источник", settings);
    expect(await getSessionTitle(id)).toBe("как было");
    expect(lastBody).toBeNull();
  });

  it("keeps the old title when the model answers the source instead of naming it", async () => {
    const id = await newChat("посмотри на чат — причина почему он остановился");
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: "Я не имею доступа к другим чатам — вижу только этот разговор." };
    await refineSessionTitle(
      id,
      'посмотри на чат "Сжатие промпта" причина почему он остановился?',
      settings,
    );
    expect(await getSessionTitle(id)).toBe("посмотри на чат — причина почему он остановился");
  });

  it("keeps the title when the endpoint fails", async () => {
    const id = await newChat("сообщение назвало чат");
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 500, content: "boom" };
    await refineSessionTitle(id, "источник", settings);
    expect(await getSessionTitle(id)).toBe("сообщение назвало чат");
  });

  it("loses to a rename the user makes while the model is thinking", async () => {
    const id = await newChat("первое сообщение");
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: "Модельное название" };
    delayMs = 80;
    const inFlight = refineSessionTitle(id, "источник", settings);
    await new Promise((r) => setTimeout(r, 20));
    await updateSession(id, { title: "Моё название" });
    await inFlight;
    expect(await getSessionTitle(id)).toBe("Моё название");
  });

  it("leaves a second call alone while one is in flight", async () => {
    const id = await newChat("первое сообщение");
    const settings = settingsWith({ builtinProviders: [provider("p", base, ["m"])] });
    reply = { status: 200, content: "Первый ответ" };
    delayMs = 60;
    const first = refineSessionTitle(id, "источник", settings);
    await new Promise((r) => setTimeout(r, 10));
    await refineSessionTitle(id, "источник", settings);
    await first;
    expect(await getSessionTitle(id)).toBe("Первый ответ");
  });
});
