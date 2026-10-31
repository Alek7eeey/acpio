import { mkdtempSync, rmSync } from "node:fs";
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
 * model received — the prompt and the tool declarations it was handed.
 */
async function boot(
  replies: Reply[],
  settings: Partial<AppSettings> = {},
): Promise<{
  frames: Array<Record<string, unknown>>;
  bodies: Array<Record<string, unknown>>;
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
  const dir = mkdtempSync(join(tmpdir(), "acpio-plan-"));
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
  await call("session/new", { cwd: dir });
  return {
    frames,
    bodies,
    prompt: async (text) => {
      await call("session/prompt", { prompt: [{ type: "text", text }] });
    },
    close: async () => {
      agent.close();
      rmSync(dir, { recursive: true, force: true });
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

const DOCUMENT = {
  name: "Переписать экспорт чата",
  overview: "Экспорт знает про план, но не про туду: три шага, последний — тесты.",
  plan: "## Шаги\n\n1. Прочитать `chatExport.ts`.\n2. Добавить ветку `plan`.\n3. Тесты.",
};

it("publishes the plan itself, and keeps it when a later call moves a status", async () => {
  const { frames, prompt, close } = await boot([
    {
      tool: {
        name: "plan",
        args: {
          ...DOCUMENT,
          entries: [
            { content: "Read the code", status: "in_progress" },
            { content: "Fix it" },
          ],
        },
      },
    },
    // The steps that land: the model sends the statuses alone.
    {
      tool: {
        name: "plan",
        args: {
          entries: [
            { content: "Read the code", status: "completed" },
            { content: "Fix it", status: "completed" },
          ],
        },
      },
    },
    { text: "Готово." },
  ]);
  try {
    await prompt("составь план");
    const updates = planUpdates(frames);
    expect(updates).toHaveLength(2);
    // First call: the document and the steps, on the same update the panel draws.
    expect(updates[0]).toEqual({
      sessionUpdate: "plan",
      ...DOCUMENT,
      entries: [
        { content: "Read the code", status: "in_progress", priority: "medium" },
        { content: "Fix it", status: "pending", priority: "medium" },
      ],
    });
    // Second call carries no document of its own — the plan stays in the panel
    // instead of being replaced by a bare list.
    expect(updates[1]).toEqual({
      sessionUpdate: "plan",
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

it("sends the model back to finish a plan it left open", async () => {
  const { frames, bodies, prompt, close } = await boot([
    {
      tool: {
        name: "plan",
        args: {
          entries: [
            { content: "Read the code", status: "in_progress" },
            { content: "Fix it" },
          ],
        },
      },
    },
    // The model calls it done with both steps still open: the turn is not over.
    { text: "Готово." },
    {
      tool: {
        name: "plan",
        args: {
          entries: [
            { content: "Read the code", status: "completed" },
            { content: "Fix it", status: "completed" },
          ],
        },
      },
    },
    { text: "Готово." },
  ]);
  try {
    await prompt("сделай");
    // plan, answer, the nudge, the finished plan, its answer.
    expect(bodies).toHaveLength(4);
    const last = lastMessageText(bodies[2] ?? {});
    expect(last).toContain("The plan is not finished");
    expect(last).toContain("Read the code (in_progress)");
    expect(last).toContain("Fix it (pending)");
    // The panel ends the turn closed, and the reader is told why the turn ran on.
    const updates = planUpdates(frames);
    expect(updates.at(-1)?.entries).toEqual([
      { content: "Read the code", status: "completed", priority: "medium" },
      { content: "Fix it", status: "completed", priority: "medium" },
    ]);
    const notes = frames
      .map((f) => (f.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }))
      .filter((u) => u?.update?.sessionUpdate === "agent_thought_chunk")
      .map((u) => String(u?.update?.content?.text ?? ""));
    expect(notes.join("\n")).toContain("План не закрыт");
  } finally {
    await close();
  }
});

it("nudges at most twice when the model will not close its plan", async () => {
  const { bodies, prompt, close } = await boot([
    {
      tool: {
        name: "plan",
        args: { entries: [{ content: "Fix it", status: "in_progress" }] },
      },
    },
    // From here on the model only ever answers, never closing the step.
    { text: "Не могу." },
  ]);
  try {
    await prompt("сделай");
    // plan, answer, the first nudge, the second — then the turn is let go.
    expect(bodies).toHaveLength(4);
    const nudges = bodies.filter((body) =>
      lastMessageText(body).includes("The plan is not finished"),
    );
    expect(nudges).toHaveLength(2);
  } finally {
    await close();
  }
});

it("leaves the plan tool out of the turn when the switch is off", async () => {
  const { bodies, prompt, close } = await boot([{ text: "ok" }], { builtinPlanTool: false });
  try {
    await prompt("сделай");
    const tools = (bodies[0]?.tools ?? []) as Array<{ function?: { name?: string } }>;
    expect(tools.map((t) => t.function?.name)).not.toContain("plan");
    const messages = (bodies[0]?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    expect(String(messages[0]?.content ?? "")).not.toContain("`plan` tool");
  } finally {
    await close();
  }
});
