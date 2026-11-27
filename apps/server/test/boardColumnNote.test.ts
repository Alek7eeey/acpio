// A board column may carry instructions of its own («проведи ревью»), and they
// reach the model with every turn of a card standing in that column. They ride
// in the turn's tail — the head is the bytes the provider caches, so a note
// written mid-board must not be merged into it — while the transcript keeps the
// reader's own words: the instructions are the column's, not typed in that
// message.
//
// The assertions run through the door the board uses (POST
// /api/sessions/:id/prompt) against the deterministic fake agent, whose answer
// echoes the text it was handed: what the model read is what the test reads.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { BoardDto, SessionDetailDto, SessionDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { boards, sessions as sessionsTable } from "../src/db/schema.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

let app: FastifyInstance;
let boardId: string;
const sessionIds: string[] = [];

/** Point the omp adapter at the deterministic fake agent. */
async function connectAgent() {
  setAgentAvailable("omp", true);
  await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      // The note is written in the reader's UI language.
      locale: "ru",
      connectedProvider: "omp",
      defaultProvider: "omp",
      ompCommand: process.execPath,
      ompArgs: [FAKE_AGENT],
    },
  });
}

/** A lane of the reader's own, with the instructions it was given. */
async function addLane(title: string, instructions: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/api/boards/${boardId}/columns`,
    payload: { title },
  });
  expect(created.statusCode).toBe(200);
  const column = (created.json() as BoardDto).columns.find((c) => c.title === title)!;
  const written = await app.inject({
    method: "PATCH",
    url: `/api/boards/${boardId}/columns/${column.id}`,
    payload: { instructions },
  });
  expect(written.statusCode).toBe(200);
  return column.id;
}

/** A board task standing in `columnId` (null = wherever its stage puts it). */
async function seedTask(columnId: string | null): Promise<string> {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: "Правка логина",
      provider: "omp",
      cwd: process.cwd(),
      mode: "agent",
      status: "idle",
      boardId,
      taskDescription: "Правка логина",
      boardColumnId: columnId,
    })
    .returning();
  sessionIds.push(row.id);
  return row.id;
}

/** The turn has said something: a thought-only row is written before the words. */
function answered(detail: SessionDetailDto): boolean {
  return detail.messages.some(
    (m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"),
  );
}

/** Poll GET /api/sessions/:id until `check` passes (a real child process runs the turn). */
async function waitForDetail(
  sessionId: string,
  check: (detail: SessionDetailDto) => boolean,
  timeoutMs = 8000,
): Promise<SessionDetailDto> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionDetailDto | null = null;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    last = res.json() as SessionDetailDto;
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`session never reached the expected state: ${JSON.stringify(last?.messages)}`);
}

/** The text parts of the messages of one role, joined. */
function textOf(detail: SessionDetailDto, role: "user" | "assistant"): string {
  return detail.messages
    .filter((m) => m.role === role)
    .flatMap((m) => m.parts)
    .map((p) => (p.type === "text" ? String(p.payload.text ?? "") : ""))
    .join("\n");
}

/** What the agent answered — the fake agent echoes the text it was handed. */
function echoed(detail: SessionDetailDto): string {
  return textOf(detail, "assistant");
}

/** What the reader's own message says — the transcript, not the turn. */
function said(detail: SessionDetailDto): string {
  return textOf(detail, "user");
}

beforeEach(async () => {
  app = await buildApp();
  await db.delete(sessionsTable);
  await db.delete(boards);
  const [row] = await db.insert(boards).values({ name: "Board" }).returning();
  boardId = row.id;
  // Seed the four homes the way a first board read does.
  await app.inject({ method: "GET", url: "/api/boards" });
});

afterEach(async () => {
  for (const id of sessionIds.splice(0)) disposeRuntime(id);
  await app.close();
});

useResetDb();

describe("a board column's instructions", () => {
  it("rides the turn of a card standing in the column, and not the transcript", async () => {
    await connectAgent();
    const lane = await addLane("Review", "Проведи ревью изменений и перечисли замечания.");
    const id = await seedTask(lane);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "поправь тесты" },
    });
    expect(res.statusCode).toBe(200);

    const detail = await waitForDetail(id, answered);
    // The model read the column's instructions after the reader's words.
    const model = echoed(detail);
    expect(model).toContain("поправь тесты");
    expect(model).toContain("[Инструкции колонки «Review»]");
    expect(model).toContain("Проведи ревью изменений и перечисли замечания.");
    expect(model.indexOf("поправь тесты")).toBeLessThan(
      model.indexOf("[Инструкции колонки «Review»]"),
    );
    // The chat keeps the reader's own words: nobody typed the instructions here.
    expect(said(detail).trim()).toBe("поправь тесты");
  });

  it("adds nothing while the column carries none", async () => {
    await connectAgent();
    const lane = await addLane("Deferred", "");
    const id = await seedTask(lane);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/prompt`,
      payload: { text: "разбуди позже" },
    });
    expect(res.statusCode).toBe(200);

    const detail = await waitForDetail(id, answered);
    expect(echoed(detail)).toContain("echo: разбуди позже");
    expect(echoed(detail)).not.toContain("Инструкции колонки");
  });

  // The column a card stands in is its placement, not the board: a card the
  // lifecycle leaves in Todo takes Todo's instructions, and a card sitting on
  // no board at all takes none — the note costs a query only where it can exist.
  it("follows the column the card stands in, not the board", async () => {
    await connectAgent();
    const review = await addLane("Review", "Только ревью, ничего не правь.");
    const todo = (await app.inject({ method: "GET", url: "/api/boards" })).json() as BoardDto[];
    await app.inject({
      method: "PATCH",
      url: `/api/boards/${boardId}/columns/todo`,
      payload: { instructions: "Сначала пойми задачу." },
    });
    expect(todo[0]!.columns.some((c) => c.id === "todo")).toBe(true);

    const inTodo = await seedTask(null);
    const inReview = await seedTask(review);
    const plain = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd: process.cwd() } })
    ).json() as SessionDto;

    for (const id of [inTodo, inReview, plain.id]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/prompt`,
        payload: { text: "дальше" },
      });
      expect(res.statusCode).toBe(200);
    }

    const todoTurn = await waitForDetail(inTodo, answered);
    expect(echoed(todoTurn)).toContain("[Инструкции колонки «Todo»]");
    expect(echoed(todoTurn)).toContain("Сначала пойми задачу.");

    const reviewTurn = await waitForDetail(inReview, answered);
    expect(echoed(reviewTurn)).toContain("Только ревью, ничего не правь.");
    expect(echoed(reviewTurn)).not.toContain("Сначала пойми задачу.");

    // A chat that is no task of any board stands in no column.
    const plainTurn = await waitForDetail(plain.id, answered);
    expect(echoed(plainTurn)).not.toContain("Инструкции колонки");
  });
});
