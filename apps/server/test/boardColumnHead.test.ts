// A board column's instructions are a note in the turn's tail, never a line of
// the head: the head is the bytes the provider caches (see AGENTS.md), and a
// column's instructions are written in the middle of a board's life — merged
// into the head they would bill the whole history again.
//
// This measures the wire instead of trusting the comment: the real prompt route
// drives the real in-process agent against a stub `/chat/completions` endpoint,
// and the recorded request bodies are compared. Two cards, one in a lane that
// carries instructions and one in a lane that does not, must send the *same*
// system message byte for byte; the notes differ only in the last user message.
// Then a second turn of the same card: the previous request's messages are a
// prefix of the new one, so the cached part is never rewritten.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BoardDto, SessionDetailDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { boards, sessions as sessionsTable } from "../src/db/schema.js";
import { disposeRuntime } from "../src/acp/sessionManager.js";

/** The instructions the lane carries — long enough to be unmistakable on the wire. */
const INSTRUCTIONS = "Проведи ревью изменений: перечисли замечания и напиши отчёт в чат.";

let app: FastifyInstance;
let boardId: string;
let modelServer: http.Server;
let modelUrl = "";
/** Every request body the built-in agent posted, in order. */
const bodies: Array<Record<string, unknown>> = [];
const sessionIds: string[] = [];

/** One request's messages, as the agent wrote them. */
function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const list = body.messages;
  return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

/** The system message — the head — as the exact bytes that went out. */
function headOf(body: Record<string, unknown>): string {
  return JSON.stringify(messagesOf(body)[0] ?? {});
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The text of the last user message: this turn's own words. */
function lastUserText(body: Record<string, unknown>): string {
  const messages = messagesOf(body);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    return "";
  }
  return "";
}

/** Answer the agent's own turn with one streamed sentence, recording the body. */
function startModelStub() {
  return new Promise<void>((resolve) => {
    modelServer = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object") bodies.push(parsed as Record<string, unknown>);
        } catch {
          // not a completion body: nothing to measure
        }
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) =>
          `data: ${JSON.stringify(payload)}\n\n`;
        res.write(
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
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
    modelServer.listen(0, "127.0.0.1", () => {
      const address = modelServer.address();
      const port = address && typeof address === "object" ? address.port : 0;
      modelUrl = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
}

/** Point the in-process agent at the stub, in the reader's own language. */
async function configureAgent(locale: "ru" | "en" = "ru") {
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      locale,
      // The title model would post to the same stub; this measures turns only.
      chatAutoTitle: false,
      connectedProvider: "builtin",
      defaultProvider: "builtin",
      builtinProviders: [
        {
          id: "p1",
          name: "Stub",
          url: modelUrl,
          apiKey: "",
          models: [{ id: "m1", label: "Stub One", contextWindow: 32_000 }],
        },
      ],
    },
  });
  expect(res.statusCode).toBe(200);
}

/** Write a column's instructions through the route the settings dialog uses. */
async function setInstructions(columnId: string, instructions: string) {
  const written = await app.inject({
    method: "PATCH",
    url: `/api/boards/${boardId}/columns/${columnId}`,
    payload: { instructions },
  });
  expect(written.statusCode).toBe(200);
}

/** A lane of the reader's own, with the instructions it was given. */
async function addLane(instructions: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/api/boards/${boardId}/columns`,
    payload: { title: "Review" },
  });
  expect(created.statusCode).toBe(200);
  const column = (created.json() as BoardDto).columns.find((c) => c.title === "Review")!;
  await setInstructions(column.id, instructions);
  return column.id;
}

/** Take the card off its lane: the lifecycle decides where it stands again. */
async function leaveLane(sessionId: string) {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}`,
    payload: { boardColumnId: null },
  });
  expect(res.statusCode).toBe(200);
}

/** Put the card into a lane by hand, as a drop does. */
async function placeInLane(sessionId: string, columnId: string) {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}`,
    payload: { boardColumnId: columnId },
  });
  expect(res.statusCode).toBe(200);
}

/** A board task standing in `columnId` (null = wherever its stage puts it). */
async function seedTask(columnId: string | null, description: string): Promise<string> {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: description,
      provider: "builtin",
      model: "p1::m1",
      cwd: process.cwd(),
      mode: "agent",
      status: "idle",
      boardId,
      taskDescription: description,
      boardColumnId: columnId,
    })
    .returning();
  sessionIds.push(row.id);
  return row.id;
}

/** Poll the detail until `turn` answers have landed (one per prompt). */
async function waitForAnswer(id: string, turn: number): Promise<SessionDetailDto> {
  const deadline = Date.now() + 8000;
  let last: SessionDetailDto | null = null;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${id}` });
    expect(res.statusCode).toBe(200);
    last = res.json() as SessionDetailDto;
    const answered = last.messages.filter(
      (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"),
    ).length;
    if (answered >= turn) return last;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`no answer: ${JSON.stringify(last?.messages)}`);
}

/** Send one prompt through the route the board and the chat both use. */
async function prompt(
  id: string,
  text: string,
  turn: number,
  extra: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: `/api/sessions/${id}/prompt`,
    payload: { text, ...extra },
  });
  expect(res.statusCode).toBe(200);
  await waitForAnswer(id, turn);
}

beforeEach(async () => {
  app = await buildApp();
  bodies.length = 0;
  await startModelStub();
  await db.delete(sessionsTable);
  await db.delete(boards);
  const [row] = await db.insert(boards).values({ name: "Board" }).returning();
  boardId = row.id;
  await app.inject({ method: "GET", url: "/api/boards" });
});

afterEach(async () => {
  for (const id of sessionIds.splice(0)) disposeRuntime(id);
  await new Promise<void>((resolve, reject) =>
    modelServer.close((err) => (err ? reject(err) : resolve())),
  );
  await app.close();
});

useResetDb();

describe("a board column's instructions and the cached head", () => {
  it("leaves the system head byte-identical and rides only the turn's tail", async () => {
    await configureAgent();
    const lane = await addLane(INSTRUCTIONS);
    const withNote = await seedTask(lane, "Проверить импорт CAD");
    const withoutNote = await seedTask(null, "Починить кнопку сохранения");

    await prompt(withNote, "продолжай", 1);
    await prompt(withoutNote, "продолжай", 1);

    expect(bodies.length).toBe(2);
    const [noted, plain] = bodies as [Record<string, unknown>, Record<string, unknown>];
    // The head is the first message, and it really is the system one: a note
    // that grew into messages[0] would stop being a tail the cache ignores.
    expect(messagesOf(noted)[0]?.role).toBe("system");

    // The head — the bytes the provider caches — is the same request to request
    // and carries nothing of the lane: the note is not a system line.
    expect(sha(headOf(noted))).toBe(sha(headOf(plain)));
    expect(headOf(noted)).not.toContain(INSTRUCTIONS);
    expect(headOf(noted)).not.toContain("Инструкции колонки");

    // The note is in this turn's own words, after them, never before.
    const notedTail = lastUserText(noted);
    expect(notedTail).toContain("продолжай");
    expect(notedTail).toContain(`[Инструкции колонки «Review»]\n${INSTRUCTIONS}`);
    expect(notedTail.indexOf("продолжай")).toBeLessThan(notedTail.indexOf(INSTRUCTIONS));
    // The lane without instructions sends the reader's words alone.
    expect(lastUserText(plain)).not.toContain("Инструкции колонки");
  });

  it("sends the previous request's messages as an unchanged prefix, and the note once", async () => {
    await configureAgent();
    const lane = await addLane(INSTRUCTIONS);
    const id = await seedTask(lane, "Проверить импорт CAD");

    await prompt(id, "начни", 1);
    await prompt(id, "теперь тесты", 2);
    await prompt(id, "и ещё раз", 3);

    expect(bodies.length).toBe(3);
    const [first, second, third] = bodies as Array<Record<string, unknown>>;
    const before = messagesOf(first);
    const after = messagesOf(second);

    // Everything the first request sent is byte for byte the head of the second
    // one — the cached prefix answers, and only the new tail is billed.
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length).map((m) => JSON.stringify(m))).toEqual(
      before.map((m) => JSON.stringify(m)),
    );
    // The notes went with the card's first turn in the lane and never came back:
    // a follow-up is the reader's own words, nothing else.
    expect(lastUserText(first)).toContain(INSTRUCTIONS);
    expect(lastUserText(second)).toContain("теперь тесты");
    expect(lastUserText(second)).not.toContain(INSTRUCTIONS);
    expect(lastUserText(third)).toContain("и ещё раз");
    expect(lastUserText(third)).not.toContain(INSTRUCTIONS);
    // Three turns, one head: nothing about the lane ever reaches it.
    expect(sha(headOf(third))).toBe(sha(headOf(first)));
  });

  // The instructions are written in the middle of a board's life, and editing
  // them must not cost a head rebuild: the same bytes go out, the new text
  // arrives in the next turn's tail.
  it("keeps the same head while the column's instructions are rewritten mid-session", async () => {
    await configureAgent();
    const lane = await addLane("Прочитай задачу и ничего не меняй.");
    const id = await seedTask(lane, "Проверить импорт CAD");

    await prompt(id, "начни", 1);
    await setInstructions(lane, INSTRUCTIONS);
    await prompt(id, "теперь ревью", 2);
    await prompt(id, "и ещё", 3);

    expect(bodies.length).toBe(3);
    const [before, after, third] = bodies as Array<Record<string, unknown>>;
    expect(sha(headOf(before))).toBe(sha(headOf(after)));
    expect(sha(headOf(third))).toBe(sha(headOf(before)));
    expect(headOf(after)).not.toContain(INSTRUCTIONS);
    // The old text stayed in history where it belonged; the rewritten one rides
    // the turn that came after the write — once, because it is a new phase.
    expect(lastUserText(before)).toContain("Прочитай задачу и ничего не меняй.");
    expect(lastUserText(after)).toContain(INSTRUCTIONS);
    expect(lastUserText(after)).not.toContain("Прочитай задачу и ничего не меняй.");
    expect(lastUserText(third)).not.toContain(INSTRUCTIONS);
  });

  // The note is a phase the chat has already been told about: leaving the lane
  // and coming back adds nothing, while a card that never read it still does.
  it("hands the note over once per card, never again for the same words", async () => {
    await configureAgent();
    const lane = await addLane(INSTRUCTIONS);
    const first = await seedTask(lane, "Проверить импорт CAD");

    await prompt(first, "начни", 1);
    await leaveLane(first);
    await prompt(first, "готово", 2);
    await placeInLane(first, lane);
    await prompt(first, "вернулся", 3);
    // Another card in the same lane has read nothing yet.
    const second = await seedTask(lane, "Второй");
    await prompt(second, "начни", 1);

    expect(bodies.length).toBe(4);
    const [inLane, outOfLane, back, other] = bodies as Array<Record<string, unknown>>;
    expect(lastUserText(inLane)).toContain(INSTRUCTIONS);
    expect(lastUserText(outOfLane)).not.toContain(INSTRUCTIONS);
    expect(lastUserText(back)).not.toContain(INSTRUCTIONS);
    expect(lastUserText(other)).toContain(INSTRUCTIONS);
    // Only the tail ever changes: the head is the same bytes every time.
    expect(sha(headOf(outOfLane))).toBe(sha(headOf(inLane)));
    expect(sha(headOf(other))).toBe(sha(headOf(inLane)));
  });

  // The harness's own prompts (the plan's approval) are the app talking, not a
  // step of the reader's workflow: they take no note, and the lane keeps its
  // instructions for the turns the reader does write.
  it("leaves the harness's own prompt without the note", async () => {
    await configureAgent();
    const lane = await addLane(INSTRUCTIONS);
    const id = await seedTask(lane, "Проверить импорт CAD");

    await prompt(id, "одобряю план", 1, { internal: true });
    await prompt(id, "продолжай", 2);

    expect(bodies.length).toBe(2);
    const [internalTurn, readerTurn] = bodies as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(lastUserText(internalTurn)).toBe("одобряю план");
    expect(lastUserText(internalTurn)).not.toContain("Инструкции колонки");
    expect(lastUserText(readerTurn)).toContain(INSTRUCTIONS);
  });

  // The note is written in the reader's language, and a home the reader never
  // renamed is named by its stage — not by its id.
  it("writes the note in the reader's language, naming a home by its stage", async () => {
    await configureAgent("en");
    await setInstructions("todo", "Read the change first.");
    const lane = await addLane("");
    const inTodo = await seedTask(null, "Check the CAD import");
    const inLane = await seedTask(lane, "Fix the save button");

    await prompt(inTodo, "start", 1);
    await prompt(inLane, "start", 1);

    expect(bodies.length).toBe(2);
    const [noted, plain] = bodies as [Record<string, unknown>, Record<string, unknown>];
    expect(lastUserText(noted)).toContain("[Column “Todo” instructions]\nRead the change first.");
    expect(lastUserText(plain)).not.toContain("instructions]");
    expect(sha(headOf(noted))).toBe(sha(headOf(plain)));
  });
});
