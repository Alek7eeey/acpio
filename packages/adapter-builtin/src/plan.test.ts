import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";

/** What the stub model answers one request with: a tool call or plain text. */
type Reply = { tool?: { name: string; args: unknown }; text?: string };

type Chunk = (payload: unknown) => string;

/** One streamed answer on the wire the built-in agent reads. */
function answer(reply: Reply, index: number, chunk: Chunk): string {
  const delta = reply.tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call-${index}`,
            type: "function",
            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
          },
        ],
      }
    : { role: "assistant", content: reply.text ?? "ok" };
  return [
    chunk({
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub",
      choices: [{ index: 0, delta, finish_reason: null }],
    }),
    chunk({
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "stub",
      choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }],
    }),
    "data: [DONE]\n\n",
  ].join("");
}

/**
 * A stub OpenAI-compatible endpoint answering `replies` in order (the last one
 * repeats), plus a booted built-in agent over it. `bodies` are the requests the
 * model received — the prompt and the tool declarations it was handed; `dir` is
 * the working folder the plan file lands in.
 */
async function boot(
  replies: Reply[],
  settings: Partial<AppSettings> = {},
  /** What the reader answers the plan approval card with. */
  approval: "accepted" | "rejected" = "accepted",
  /** Working folder to share with another chat — its own when omitted. */
  sharedDir?: string,
): Promise<{
  frames: Array<Record<string, unknown>>;
  bodies: Array<Record<string, unknown>>;
  dir: string;
  sessionId: string;
  prompt: (text: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        /* a body we cannot read answers like an empty turn */
      }
      bodies.push(parsed);
      const reply = replies[Math.min(bodies.length - 1, replies.length - 1)] ?? { text: "ok" };
      res.setHeader("content-type", "text/event-stream");
      res.end(
        answer(reply, bodies.length, (payload) => `data: ${JSON.stringify(payload)}\n\n`),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const dir = sharedDir ?? mkdtempSync(join(tmpdir(), "acpio-plan-"));
  const agent = createBuiltinTransport({
    settings: {
      ...DEFAULT_SETTINGS,
      builtinProviders: [
        {
          id: "p1",
          name: "Stub",
          url: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "",
          models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
        },
      ],
      ...settings,
    },
    cwd: dir,
    mode: "agent",
    stateDir: dir,
  });
  const frames: Array<Record<string, unknown>> = [];
  const pending = new Map<number, (f: Record<string, unknown>) => void>();
  let nextId = 1;
  agent.onLine((line) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    frames.push(frame);
    // The approval card is the harness's: answer it like the panel would.
    if (frame.method === "builtin/plan_approval") {
      agent.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: { outcome: { outcome: approval } },
        }),
      );
      return;
    }
    if (typeof frame.id !== "number" || typeof frame.method === "string") return;
    const done = pending.get(frame.id);
    pending.delete(frame.id);
    done?.(frame);
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      pending.set(id, (f) => resolve((f.result ?? {}) as Record<string, unknown>));
      agent.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await call("initialize", { protocolVersion: 1 });
  const opened = await call("session/new", { cwd: dir });
  return {
    frames,
    bodies,
    dir,
    sessionId: String(opened.sessionId ?? ""),
    prompt: async (text) => {
      await call("session/prompt", { prompt: [{ type: "text", text }] });
    },
    close: async () => {
      agent.close();
      // A folder two chats share belongs to the caller.
      if (!sharedDir) rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every `session/update: plan` frame the harness would draw in the panel. */
function planUpdates(frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return frames
    .filter(
      (f) =>
        f.method === "session/update" &&
        (f.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === "plan",
    )
    .map((f) => (f.params as { update: Record<string, unknown> }).update);
}

/** Text of the last message a request carried — the nudge, when there is one. */
function lastMessageText(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{ content?: unknown }>;
  const content = messages.at(-1)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "",
    )
    .join("\n");
}

function nudges(bodies: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return bodies.filter((body) => lastMessageText(body).includes("The plan is not finished"));
}

const DOCUMENT = {
  name: "Переписать экспорт чата",
  problem: "Экспорт теряет план: читатель копирует переписку и остаётся без шагов.",
  overview: "Экспорт знает про план, но не про туду: три шага, последний — тесты.",
  plan: "## Файлы\n\n`chatExport.ts` — ветка `plan`.\n\n## Проверка\n\n`npm test`.",
};

const STEPS = [
  { content: "Read the code", status: "in_progress" },
  { content: "Fix it" },
];

const CLOSED = [
  { content: "Read the code", status: "completed" },
  { content: "Fix it", status: "completed" },
];

it("writes the plan file and publishes it, keeping the document on a status-only call", async () => {
  const { frames, prompt, dir, close } = await boot([
    { tool: { name: "plan", args: { ...DOCUMENT, entries: STEPS } } },
    // The steps that land: the model sends the statuses alone.
    { tool: { name: "plan", args: { entries: CLOSED } } },
    { text: "Готово." },
  ]);
  try {
    await prompt("составь план");
    const updates = planUpdates(frames);
    expect(updates).toHaveLength(2);
    // The plan is a file the reader can open, edit and keep.
    const file = join(dir, ".acpio", "plan.md");
    expect(existsSync(file)).toBe(true);
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain("stage: draft");
    expect(onDisk).toContain(DOCUMENT.name);
    expect(onDisk).toContain("- [x] Read the code");
    // The panel gets the same state, plus where it lives.
    expect(updates[0]).toEqual({
      sessionUpdate: "plan",
      ...DOCUMENT,
      path: ".acpio/plan.md",
      stage: "draft",
      pacing: "whole",
      entries: [
        { content: "Read the code", status: "in_progress", priority: "medium" },
        { content: "Fix it", status: "pending", priority: "medium" },
      ],
    });
    // The second call carries no document of its own — the plan stays in the
    // panel instead of being replaced by a bare list.
    expect(updates[1]).toMatchObject({
      ...DOCUMENT,
      entries: [
        { content: "Read the code", status: "completed", priority: "medium" },
        { content: "Fix it", status: "completed", priority: "medium" },
      ],
    });
  } finally {
    await close();
  }
});

it("sends the model back to finish a plan the reader approved", async () => {
  const { frames, bodies, prompt, close } = await boot([
    {
      tool: {
        name: "plan",
        args: { problem: DOCUMENT.problem, overview: DOCUMENT.overview, entries: STEPS },
      },
    },
    { tool: { name: "apply_plan", args: {} } },
    // The model calls it done with both steps still open: the turn is not over.
    { text: "Готово." },
    { tool: { name: "plan", args: { entries: CLOSED } } },
    { text: "Готово." },
  ]);
  try {
    await prompt("сделай");
    // plan, apply, answer, the nudge, the finished plan and its answer.
    expect(bodies).toHaveLength(5);
    const last = lastMessageText(bodies[3] ?? {});
    expect(last).toContain("The plan is not finished");
    expect(last).toContain("Read the code (in_progress)");
    expect(last).toContain("Fix it (pending)");
    // Approval flipped the stage the panel draws.
    expect(planUpdates(frames).some((update) => update.stage === "applying")).toBe(true);
    const notes = frames
      .map((f) => (f.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }))
      .filter((u) => u?.update?.sessionUpdate === "agent_thought_chunk")
      .map((u) => String(u?.update?.content?.text ?? ""));
    expect(notes.join("\n")).toContain("План не закрыт");
  } finally {
    await close();
  }
});

it("never pushes a plan the reader has not approved", async () => {
  const { bodies, prompt, close } = await boot([
    { tool: { name: "plan", args: { entries: STEPS } } },
    // A draft is what the reader is reading: stopping here is the whole point.
    { text: "План готов, смотри." },
  ]);
  try {
    await prompt("составь план, ничего не делай");
    expect(bodies).toHaveLength(2);
    expect(nudges(bodies)).toHaveLength(0);
  } finally {
    await close();
  }
});

it("leaves the model alone when the reader asked for one step at a time", async () => {
  const { bodies, prompt, close } = await boot([
    { tool: { name: "plan", args: { entries: STEPS } } },
    { tool: { name: "apply_plan", args: { pacing: "step" } } },
    { text: "Первый шаг сделал." },
  ]);
  try {
    await prompt("по одному шагу, спрашивай меня");
    // plan, apply, the answer — and nothing after it: the floor is the reader's.
    expect(bodies).toHaveLength(3);
    expect(nudges(bodies)).toHaveLength(0);
  } finally {
    await close();
  }
});

it("nudges at most twice when the model will not close an approved plan", async () => {
  const { bodies, prompt, close } = await boot([
    {
      tool: {
        name: "plan",
        args: {
          problem: "Экспорт теряет план.",
          entries: [{ content: "Fix it", status: "in_progress" }],
        },
      },
    },
    { tool: { name: "apply_plan", args: {} } },
    // From here on the model only ever answers, never closing the step.
    { text: "Не могу." },
  ]);
  try {
    await prompt("сделай");
    // plan, apply, answer, the first nudge, the second — then the turn is let go.
    expect(bodies).toHaveLength(5);
    expect(nudges(bodies)).toHaveLength(2);
  } finally {
    await close();
  }
});

it("keeps one chat's plan out of the other chat in the same folder", async () => {
  // Two chats, one working folder — the case where the same plan opened in both:
  // the plan file is shared, so the file has to say whose plan it is.
  const folder = mkdtempSync(join(tmpdir(), "acpio-plan-two-chats-"));
  const a = await boot(
    [
      { tool: { name: "plan", args: { ...DOCUMENT, entries: STEPS } } },
      { text: "План готов." },
      // A closes its steps later on: the file moves under the other chat's watcher.
      { tool: { name: "plan", args: { entries: CLOSED } } },
      { text: "Готово." },
    ],
    {},
    "accepted",
    folder,
  );
  try {
    await a.prompt("составь план");
    const file = join(folder, ".acpio", "plan.md");
    expect(planUpdates(a.frames)).toHaveLength(1);

    const b = await boot(
      [{ tool: { name: "plan", args: { entries: [{ content: "Свой шаг" }] } } }, { text: "ok" }],
      {},
      "accepted",
      folder,
    );
    try {
      // The file moves while B is open: A's plan is not B's news.
      await a.prompt("закрой шаги");
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(planUpdates(b.frames)).toHaveLength(0);
      // The plan file names its chat, and that is what the two of them go by.
      expect(readFileSync(file, "utf8")).toContain(`chat: ${a.sessionId}`);
      // B's own plan starts from nothing — not from the steps A left in the file.
      await b.prompt("составь свой план");
      const [own] = planUpdates(b.frames);
      expect(own).toMatchObject({ entries: [{ content: "Свой шаг", status: "pending" }] });
      expect(own?.name).toBeUndefined();
      // The file is B's now, and A's plan went to the archive instead of being
      // overwritten where it lay.
      expect(readFileSync(file, "utf8")).toContain(`chat: ${b.sessionId}`);
      expect(readdirSync(join(folder, ".acpio", "plans"))).toHaveLength(1);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("leaves the plan tools out of the turn when the switch is off", async () => {
  const { bodies, prompt, close } = await boot([{ text: "ok" }], { builtinPlanTool: false });
  try {
    await prompt("сделай");
    const tools = (bodies[0]?.tools ?? []) as Array<{ function?: { name?: string } }>;
    const names = tools.map((t) => t.function?.name);
    expect(names).not.toContain("plan");
    expect(names).not.toContain("apply_plan");
    const messages = (bodies[0]?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    expect(String(messages[0]?.content ?? "")).not.toContain("`plan` tool");
  } finally {
    await close();
  }
});
