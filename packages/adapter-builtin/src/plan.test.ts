import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@acpio/shared";
import { createBuiltinTransport } from "./agent.js";

it("emits an ACP plan update when the model calls the plan tool", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      const chunk = (p: unknown) => `data: ${JSON.stringify(p)}\n\n`;
      if (requests === 1) {
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
                      function: {
                        name: "plan",
                        arguments: JSON.stringify({
                          entries: [
                            { content: "Read the code", status: "in_progress" },
                            { content: "Fix it" },
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
      } else {
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
          }),
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
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
  try {
    await call("initialize", { protocolVersion: 1 });
    await call("session/new", { cwd: dir });
    await call("session/prompt", { prompt: [{ type: "text", text: "do it" }] });
    const plan = frames.find(
      (f) =>
        f.method === "session/update" &&
        (f.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === "plan",
    );
    expect(plan).toBeTruthy();
    expect((plan!.params as { update: unknown }).update).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", status: "in_progress", priority: "medium" },
        { content: "Fix it", status: "pending", priority: "medium" },
      ],
    });
  } finally {
    agent.close();
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
