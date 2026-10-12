// Background jobs: the MCP server acpio hands every chat, its REST twin for
// the tasks page, and the note a settled job delivers to the conversation.
// Fastify inject against the in-memory DB (see test-utils.ts), with real shell
// processes — the runner's whole job is to spawn one and watch it die.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import {
  BG_MCP_SERVER_NAME,
  DEFAULT_SETTINGS,
  bgMcpToolName,
  parseBackgroundJobNote,
  builtinMcpServers,
  type BackgroundJobDto,
  type SessionDetailDto,
} from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { sessions as sessionsTable } from "../src/db/schema.js";
import {
  disposeRuntime,
  notifyBackgroundJobDone,
  setAgentAvailable,
} from "../src/acp/sessionManager.js";
import {
  clearFinishedBackgroundJobs,
  forgetBackgroundJob,
  formatBackgroundJobNote,
  listBackgroundJobs,
  readBackgroundJobOutput,
  setBackgroundJobDoneHandler,
  startBackgroundJob,
  stopBackgroundJob,
  resolveBackgroundMcp,
} from "../src/services/backgroundJobs.js";

let app: FastifyInstance;
/** Sessions whose ACP runtime (the fake agent process) must be disposed. */
const runtimeSessionIds: string[] = [];
const tempDirs: string[] = [];
/** Deterministic fake ACP agent, wired as the omp command (see routes.test.ts). */
const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

beforeEach(async () => {
  app = await buildApp();
});
// After the boot hook on purpose: the in-memory DB has no tables until
// `buildApp` ran `ensureSchema`, and wiping them first throws.
useResetDb();

afterEach(async () => {
  setBackgroundJobDoneHandler(null);
  clearFinishedBackgroundJobs();
  for (const id of runtimeSessionIds.splice(0)) disposeRuntime(id);
  // Best effort: the fake agent's cwd is one of these folders and Windows can
  // still hold it for a moment after the process was asked to go.
  for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await app.close();
});

async function seedChat(opts: { title?: string; cwd?: string } = {}) {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: opts.title ?? "Seeded chat",
      provider: "builtin",
      cwd: opts.cwd ?? process.cwd(),
      mode: "agent",
    })
    .returning();
  return row;
}

/** The endpoint URL the chat is handed at `session/new`, as path + query. */
function endpointFor(sessionId: string): string {
  const entry = resolveBackgroundMcp(builtinMcpServers(DEFAULT_SETTINGS), sessionId)[0];
  expect(entry?.name).toBe(BG_MCP_SERVER_NAME);
  const url = new URL(entry!.url!);
  return `${url.pathname}${url.search}`;
}

/** A fresh URL without the token — the lock the endpoint has to keep. */
function endpointWithoutToken(sessionId: string): string {
  const url = new URL(endpointFor(sessionId), "http://127.0.0.1");
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}`;
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function mcp(sessionId: string, payload: unknown, url = endpointFor(sessionId)) {
  return app.inject({ method: "POST", url, payload });
}

function toolCall(sessionId: string, name: string, args: Record<string, unknown> = {}) {
  return mcp(sessionId, rpc("tools/call", { name, arguments: args }, 7));
}

/** Result text of a `tools/call` answer. */
function toolText(res: { json: () => unknown }): string {
  const body = res.json() as { result?: { content?: Array<{ text?: string }> } };
  return body.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

function jobsFrom(res: { json: () => unknown }): BackgroundJobDto[] {
  return (res.json() as { jobs: BackgroundJobDto[] }).jobs;
}

/** Poll the chat until its transcript satisfies the predicate (see routes.test). */
async function waitForDetail(
  sessionId: string,
  done: (detail: SessionDetailDto) => boolean,
  timeoutMs = 20_000,
): Promise<SessionDetailDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (res.statusCode === 200) {
      const detail = res.json() as SessionDetailDto;
      if (done(detail)) return detail;
    }
    if (Date.now() >= deadline) throw new Error(`session ${sessionId} never showed the expected detail`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForJob(
  id: string,
  status: BackgroundJobDto["status"],
  timeoutMs = 20_000,
): Promise<BackgroundJobDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = listBackgroundJobs().find((known) => known.id === id);
    if (job && job.status === status) return job;
    if (Date.now() >= deadline) {
      throw new Error(`job ${id} never reached "${status}" (last: ${job?.status ?? "missing"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("the built-in background MCP server", () => {
  it("gets this boot's endpoint, scoped to the chat", () => {
    // The chat's own servers come out of the resolver untouched, and the
    // built-in entry keeps its place at the end of the list.
    const configured = [{ id: "x", name: "other", enabled: true, type: "stdio" as const, command: "node" }];
    const list = resolveBackgroundMcp([...configured, ...builtinMcpServers(DEFAULT_SETTINGS)], "chat-1");
    expect(list.slice(0, 1)).toEqual(configured);
    const entry = list.at(-1)!;
    expect(entry.name).toBe(BG_MCP_SERVER_NAME);
    expect(entry.type).toBe("remote");
    const url = new URL(entry.url!);
    expect(url.searchParams.get("session")).toBe("chat-1");
    expect(url.searchParams.get("token")).toBeTruthy();
  });

  it("stays out of the list while it is switched off", () => {
    const off = { ...DEFAULT_SETTINGS, mcpBuiltinDisabledIds: [builtinMcpServers(DEFAULT_SETTINGS)[0].id] };
    expect(builtinMcpServers(off)).toEqual([{ ...builtinMcpServers(DEFAULT_SETTINGS)[0], enabled: false }]);
    // Nothing to resolve: the chat's agent is handed no endpoint at all.
    expect(resolveBackgroundMcp([], "chat-1")).toEqual([]);
  });

  it("initializes and lists its four tools", async () => {
    const chat = await seedChat();
    const init = await mcp(chat.id, rpc("initialize", { protocolVersion: "2024-11-05" }));
    expect(init.statusCode).toBe(200);
    expect(init.json()).toMatchObject({
      result: { serverInfo: { name: BG_MCP_SERVER_NAME } },
    });

    const listed = await mcp(chat.id, rpc("tools/list"));
    const tools = (listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["list", "output", "run", "stop"]);
  });

  it("refuses a request without the token, and one for an unknown chat", async () => {
    const chat = await seedChat();
    const noToken = await mcp(chat.id, rpc("tools/list"), endpointWithoutToken(chat.id));
    expect(noToken.statusCode).toBe(403);

    const unknown = await mcp("no-such-chat", rpc("tools/list"));
    expect(unknown.statusCode).toBe(404);
  });

  it("answers a notification with an empty 202", async () => {
    const chat = await seedChat();
    const res = await mcp(chat.id, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
  });
});

describe("running a command in the background", () => {
  it("returns a job id at once and keeps the output readable", async () => {
    const chat = await seedChat();
    const started = await toolCall(chat.id, "run", {
      command: `node -e "console.log('bg-marker-1'); console.error('bg-marker-2')"`,
      label: "marker",
    });
    expect(started.statusCode).toBe(200);
    const startedText = toolText(started);
    const id = /Started background job (bg-\d+)/.exec(startedText)?.[1];
    expect(id, startedText).toBeTruthy();

    const job = await waitForJob(id!, "exited");
    expect(job.exitCode).toBe(0);
    expect(job.label).toBe("marker");
    expect(job.sessionId).toBe(chat.id);
    expect(job.sessionTitle).toBe("Seeded chat");

    const read = await toolCall(chat.id, "output", { jobId: id });
    const text = toolText(read);
    expect(text).toContain("bg-marker-1");
    expect(text).toContain("bg-marker-2");
    expect(text).toContain("exit 0");

    // The REST twin the tasks page reads.
    const list = await app.inject({ method: "GET", url: "/api/bg" });
    expect(jobsFrom(list).map((row) => row.id)).toContain(id);
    const output = await app.inject({ method: "GET", url: `/api/bg/${id}/output` });
    expect((output.json() as { text: string }).text).toContain("bg-marker-1");
  });

  // The output is a file, not an MCP answer: the agent reads it with the same
  // `read`/`grep` it uses on any other file, so the row and the tool result
  // have to name it.
  it("writes the output to a log file and reads it in windows", async () => {
    const chat = await seedChat();
    const started = await toolCall(chat.id, "run", {
      command: `node -e "console.log('line-1'); console.log('line-2')"`,
    });
    const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1];
    await waitForJob(id!, "exited");

    const job = listBackgroundJobs().find((row) => row.id === id)!;
    expect(job.logPath.endsWith(`${id}.log`)).toBe(true);
    const onDisk = await fsp.readFile(job.logPath, "utf8");
    expect(onDisk).toContain("line-1");
    expect(onDisk).toContain("line-2");
    expect(toolText(started)).toContain(job.logPath);

    // A tail window, then "only what is new" from the cursor that read returned.
    const tail = readBackgroundJobOutput(id!, { tailLines: 1 })!;
    expect(tail.text.trim()).toBe("line-2");
    const all = readBackgroundJobOutput(id!, { since: 0 })!;
    expect(all.text).toContain("line-1");
    expect(all.to).toBeGreaterThan(0);
    expect(readBackgroundJobOutput(id!, { since: all.to })!.text).toBe("");
  });

  it("reports a failing command as failed, with its exit code", async () => {
    const chat = await seedChat();
    const started = toolCall(chat.id, "run", { command: `node -e "process.exit(3)"` });
    const id = /Started background job (bg-\d+)/.exec(toolText(await started))?.[1];
    const job = await waitForJob(id!, "failed");
    expect(job.exitCode).toBe(3);
  });

  it("keeps one chat's jobs out of another chat's reach", async () => {
    const mine = await seedChat({ title: "Mine" });
    const other = await seedChat({ title: "Other" });
    const started = await toolCall(mine.id, "run", { command: `node -e "console.log('private')"` });
    const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1];
    await waitForJob(id!, "exited");

    const stolen = await toolCall(other.id, "output", { jobId: id });
    expect(toolText(stolen)).toContain(`Unknown job "${id}"`);
    expect((stolen.json() as { result?: { isError?: boolean } }).result?.isError).toBe(true);

    const list = await toolCall(other.id, "list");
    expect(toolText(list)).toContain("no background jobs");
  });

  it("refuses a command that names a folder which does not exist", async () => {
    const chat = await seedChat();
    const res = await toolCall(chat.id, "run", {
      command: `node -e "1"`,
      cwd: "definitely/not/here",
    });
    expect(toolText(res)).toContain("Folder does not exist");
  });

  it("caps how many jobs one chat may run at once", async () => {
    const chat = await seedChat();
    const hold = `node -e "setTimeout(() => {}, 60000)"`;
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await toolCall(chat.id, "run", { command: hold, label: `hold-${i}` });
      const id = /Started background job (bg-\d+)/.exec(toolText(res))?.[1];
      expect(id).toBeTruthy();
      ids.push(id!);
    }
    const refused = await toolCall(chat.id, "run", { command: hold });
    expect(toolText(refused)).toContain("already runs 6 background jobs");
    for (const id of ids) stopBackgroundJob(id, "agent");
  }, 30_000);
});

describe("stopping a job", () => {
  it("kills the process tree when the user stops it, and tells the chat", async () => {
    const chat = await seedChat();
    const settled: BackgroundJobDto[] = [];
    setBackgroundJobDoneHandler((job) => settled.push(job));

    const started = await toolCall(chat.id, "run", {
      command: `node -e "setTimeout(() => {}, 60000)"`,
      label: "sleeper",
    });
    const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1]!;

    const stopped = await app.inject({ method: "POST", url: `/api/bg/${id}/stop` });
    expect(stopped.statusCode).toBe(200);
    const job = await waitForJob(id, "killed");
    expect(job.pid).toBeNull();
    // The note is the point: a model waiting on that job must hear it is gone.
    expect(settled.map((row) => row.id)).toEqual([id]);
    expect(settled[0]!.status).toBe("killed");
  }, 30_000);

  it("stays quiet when the agent itself stopped the job", async () => {
    const chat = await seedChat();
    const settled: BackgroundJobDto[] = [];
    setBackgroundJobDoneHandler((job) => settled.push(job));

    const started = await toolCall(chat.id, "run", {
      command: `node -e "setTimeout(() => {}, 60000)"`,
      label: "sleeper",
    });
    const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1]!;
    const stopped = await toolCall(chat.id, "stop", { jobId: id });
    expect(toolText(stopped)).toContain("stopping");
    await waitForJob(id, "killed");
    // The tool call was the notification; a second note would only interrupt.
    expect(settled).toEqual([]);
  }, 30_000);

  it("forgets a finished job, but not a running one", async () => {
    const chat = await seedChat();
    const started = await toolCall(chat.id, "run", { command: `node -e "setTimeout(() => {}, 60000)"` });
    const runningId = /Started background job (bg-\d+)/.exec(toolText(started))?.[1]!;
    const refused = await app.inject({ method: "POST", url: `/api/bg/${runningId}/forget` });
    expect(refused.statusCode).toBe(409);
    stopBackgroundJob(runningId, "agent");
    await waitForJob(runningId, "killed");

    const forgotten = await app.inject({ method: "POST", url: `/api/bg/${runningId}/forget` });
    expect(forgotten.statusCode).toBe(200);
    expect(listBackgroundJobs().some((job) => job.id === runningId)).toBe(false);
  }, 30_000);
});

describe("the note a settled job leaves in the chat", () => {
  const job: BackgroundJobDto = {
    id: "bg-7",
    sessionId: "chat-1",
    sessionTitle: "Chat",
    cwd: "C:/proj",
    label: "npm run build",
    script: "npm run build",
    logPath: "C:/data/bg-logs/chat-1/bg-7.log",
    pid: null,
    status: "failed",
    exitCode: 2,
    startedAt: 1_000,
    endedAt: 43_000,
    outputBytes: 12,
  };

  it("names the job, its exit code and the tools that read more", () => {
    const ru = formatBackgroundJobNote(job, "error TS2304: cannot find name", "ru");
    expect(ru).toContain("npm run build");
    expect(ru).toContain("код 2");
    expect(ru).toContain("error TS2304");
    expect(ru).toContain(bgMcpToolName("output"));
    expect(ru).toContain("bg-7");

    const en = formatBackgroundJobNote({ ...job, status: "exited", exitCode: 0 }, "", "en");
    expect(en).toContain("finished");
    expect(en).toContain("exit 0");
    expect(en).toContain("No output.");
  });

  // The chat draws this note as a folded block instead of a user bubble: the
  // shared parser is what tells the note apart from a real prompt. It reads the
  // template above, so the two have to keep agreeing — change a line of the
  // formatter and this fails, instead of the note silently turning back into
  // the reader's own message.
  it("reads back into the fields the chat's note block draws", () => {
    const ru = parseBackgroundJobNote(
      formatBackgroundJobNote(job, "error TS2304: cannot find name", "ru"),
    );
    expect(ru).toMatchObject({
      id: "bg-7",
      label: "npm run build",
      status: "failed",
      exitCode: "2",
      elapsed: "42s",
      command: "npm run build",
      logPath: "C:/data/bg-logs/chat-1/bg-7.log",
      output: "error TS2304: cannot find name",
      emptyOutput: false,
      rest: [],
    });
    expect(ru?.hint).toContain(bgMcpToolName("list"));

    const en = parseBackgroundJobNote(
      formatBackgroundJobNote({ ...job, status: "exited", exitCode: 0 }, "done", "en"),
    );
    expect(en).toMatchObject({ status: "exited", exitCode: "0", output: "done", rest: [] });

    const empty = parseBackgroundJobNote(
      formatBackgroundJobNote({ ...job, status: "exited", exitCode: 0 }, "", "ru"),
    );
    expect(empty).toMatchObject({ output: null, emptyOutput: true });
  });
});

describe("a settled job wakes its chat", () => {
  it("delivers the note into the conversation, output and all", async () => {
    // The boot wiring of index.ts, in miniature: the job runner hands the
    // settled job to the session manager, which owns the turn it injects.
    setBackgroundJobDoneHandler((job) => void notifyBackgroundJobDone(job));
    setAgentAvailable("omp", true);
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { connectedProvider: "omp", defaultProvider: "omp", ompCommand: process.execPath, ompArgs: [FAKE_AGENT] },
    });

    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-bg-note-"));
    tempDirs.push(cwd);
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    const session = created.json() as { id: string };
    runtimeSessionIds.push(session.id);

    const started = await toolCall(session.id, "run", {
      command: `node -e "console.log('note-marker')"`,
      label: "note job",
    });
    const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1]!;
    await waitForJob(id, "exited");

    // The chat's own transcript is the door the user watches: a new message
    // carrying the note has to land there, with the job's output in it.
    const detail = await waitForDetail(session.id, (d) =>
      d.messages.some((m) => m.parts.some((p) => String(p.payload.text ?? "").includes("note-marker"))),
    );
    const note = detail.messages
      .flatMap((m) => m.parts)
      .map((p) => String(p.payload.text ?? ""))
      .find((text) => text.includes("note-marker"))!;
    expect(note).toContain("[Background task]");
    expect(note).toContain("note job");
    expect(note).toContain(`id ${id}`);
    expect(note).toContain(bgMcpToolName("output"));
  }, 40_000);
});

/**
 * OpenAI-compatible stub driven by the test, one model call at a time.
 *
 * A `session/steer` is folded at the *start* of a model call, so a note can only
 * land in the turn if the turn has another call coming: the stub asks for a
 * cheap `glob` (no permission prompt) while the test settles a job, and answers
 * the call that drains the note with the rest of the answer.
 */
async function startTurnStub(answer: (call: number) => Promise<"tool" | "stop">) {
  const calls: Array<PromiseWithResolvers<void>> = [];
  const waiters: Array<{ index: number; resolve: () => void }> = [];
  const seen: string[] = [];
  const arrived = (index: number) => {
    if (calls.length >= index) return Promise.resolve();
    const wait = Promise.withResolvers<void>();
    waiters.push({ index, resolve: wait.resolve });
    return wait.promise;
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
      const role = (parsed.messages ?? []).at(-1)?.role ?? "?";
      seen.push(role);
      const index = seen.length;
      const arrived = Promise.withResolvers<void>();
      calls.push(arrived);
      for (const waiter of waiters.splice(0)) {
        if (waiter.index <= calls.length) waiter.resolve();
        else waiters.push(waiter);
      }
      void answer(index).then((kind) => {
        res.setHeader("content-type", "text/event-stream");
        const frame = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const delta = (value: Record<string, unknown>, finish: string | null) =>
          frame({
            id: `c${index}`,
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: value, finish_reason: finish }],
          });
        if (kind === "tool") {
          res.write(
            delta(
              {
                role: "assistant",
                content: index === 1 ? "Начал работу." : null,
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${index}`,
                    type: "function",
                    function: { name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(delta({}, "tool_calls"));
        } else {
          res.write(delta({ role: "assistant", content: " Заметку учёл." }, null));
          res.write(
            frame({
              id: `c${index}`,
              object: "chat.completion.chunk",
              created: 0,
              model: "stub",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
        arrived.resolve();
      });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    /** Resolves once the model's `index`-th call has arrived. */
    arrived,
    /** Resolves when the model's `index`-th call has been answered. */
    answered: (index: number) => arrived(index).then(() => calls[index - 1]!.promise),
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(closed.resolve);
      return closed.promise;
    },
  };
}

/**
 * The note that can still ride the running turn is written into that turn: the
 * message it belongs to is the answer the job interrupted, and the reader finds
 * it between the work that finished the job and the work the job set off.
 */
describe("a note that folds into the running turn", () => {
  it("is written into that turn, not into a message of its own", async () => {
    // The note is settled while the turn is between model calls, and is folded
    // into the call after it — the same order a real turn lives in.
    let settled = Promise.withResolvers<void>();
    const stub = await startTurnStub(async (call) => {
      if (call === 1) return "tool";
      if (call === 2) {
        await settled.promise;
        return "tool";
      }
      return "stop";
    });
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-bg-fold-"));
    tempDirs.push(cwd);
    try {
      setAgentAvailable("builtin", true);
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          connectedProvider: "builtin",
          defaultProvider: "builtin",
          // The title refinement would race its own model call into the stub.
          chatAutoTitle: false,
          builtinProviders: [
            {
              id: "p1",
              name: "Local",
              url: stub.url,
              apiKey: "",
              models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
            },
          ],
        },
      });
      expect(existsSync(cwd)).toBe(true);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { provider: "builtin", cwd },
      });
      expect(created.statusCode).toBe(200);
      const session = created.json() as { id: string };
      runtimeSessionIds.push(session.id);

      // The prompt route is fire-and-forget: the stub holds the answer open, so
      // the turn is still live when the job settles.
      const prompt = app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "начни работу" },
      });
      // The first answer is in: the turn is up and its second call is held open
      // for as long as the job needs to settle.
      await stub.answered(1);
      await stub.arrived(2);

      // The chat's own runner (the MCP endpoint the agent is handed) hands the
      // settled job to the session manager, exactly as index.ts wires it.
      setBackgroundJobDoneHandler((done) => void notifyBackgroundJobDone(done));
      const started = await toolCall(session.id, "run", {
        command: `node -e "console.log('folded-marker')"`,
        label: "folded job",
      });
      const id = /Started background job (bg-\d+)/.exec(toolText(started))?.[1];
      expect(id).toBeTruthy();
      await waitForJob(id!, "exited");
      // Let the delivery reach the running turn before the model is called
      // again — that call is what folds the note in.
      await new Promise((resolve) => setTimeout(resolve, 200));
      settled.resolve();
      // The turn runs to its end: the call that drained the note, the work it
      // asked for, and the answer the note set off.
      const detail = await waitForDetail(session.id, (d) =>
        d.status === "idle" &&
        d.messages.some((m) => m.parts.some((p) => p.type === "note")) &&
        d.messages.some((m) =>
          m.parts.some((p) => String(p.payload.text ?? "").includes("Заметку учёл")),
        ),
      );
      const notes = detail.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "note");
      expect(notes).toHaveLength(1);
      const owner = detail.messages.find((m) => m.parts.some((p) => p.id === notes[0]!.id));
      expect(owner?.role).toBe("assistant");
      // Written in place: the turn's own work stands before it, and the answer
      // the note set off keeps streaming after it into the same message.
      expect(owner!.parts[0]!.type).not.toBe("note");
      expect(owner!.parts.at(-1)!.id).not.toBe(notes[0]!.id);
      expect(owner!.parts.some((p) => p.type === "text" && p.order > notes[0]!.order)).toBe(true);
      // No message of its own: a note is not something the reader asked.
      const noteText = String(notes[0]!.payload.text);
      expect(noteText).toContain("folded-marker");
      const asMessage = detail.messages.filter((m) =>
        m.parts.some((p) => p.type === "text" && String(p.payload.text ?? "").includes("folded-marker")),
      );
      expect(asMessage).toEqual([]);

      await prompt;
    } finally {
      await stub.close();
    }
  }, 40_000);
});

describe("the runner's own bookkeeping", () => {
  it("refuses a job for a chat that no longer exists", async () => {
    await expect(
      startBackgroundJob({ sessionId: "gone", cwd: process.cwd(), script: "echo hi" }),
    ).rejects.toThrow(/Chat not found/);
  });

  it("removes a chat's row from the list when the job is forgotten", async () => {
    const chat = await seedChat();
    const job = await startBackgroundJob({
      sessionId: chat.id,
      cwd: chat.cwd,
      script: `node -e "console.log('bye')"`,
    });
    await waitForJob(job.id, "exited");
    expect(existsSync(job.logPath)).toBe(true);
    expect(forgetBackgroundJob(job.id)).toBe(true);
    expect(listBackgroundJobs().some((known) => known.id === job.id)).toBe(false);
    // The log belongs to the row: forgetting it takes the file with it.
    expect(existsSync(job.logPath)).toBe(false);
    expect(clearFinishedBackgroundJobs()).toEqual([]);
  });
});
