// A board's columns are its own data: four undeletable stage homes — the
// columns a board had before they could be edited — plus whatever lanes the
// reader adds. These assertions run through the doors the board page uses:
// GET /api/boards (what the strip renders), the column routes (what the
// editor writes) and PATCH /api/sessions/:id (what a card drop writes), with
// the placement read back the way the board list hands it to the page.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BoardDto, SessionDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { boards, sessions as sessionsTable } from "../src/db/schema.js";
import { claimBoardTaskTurn } from "../src/services/sessions.js";

let app: FastifyInstance;
let boardId: string;

async function board(): Promise<BoardDto> {
  const res = await app.inject({ method: "GET", url: "/api/boards" });
  expect(res.statusCode).toBe(200);
  const found = (res.json() as BoardDto[]).find((b) => b.id === boardId);
  expect(found).toBeTruthy();
  return found!;
}

async function addColumn(payload: Record<string, unknown>): Promise<BoardDto> {
  const res = await app.inject({
    method: "POST",
    url: `/api/boards/${boardId}/columns`,
    payload,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as BoardDto;
}

async function seedTask(patch: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: "Task",
      provider: "omp",
      cwd: "/p/app",
      mode: "agent",
      status: "idle",
      boardId,
      taskDescription: "Task",
      ...patch,
    })
    .returning();
  return row.id;
}

async function card(id: string): Promise<SessionDto> {
  const res = await app.inject({ method: "GET", url: `/api/sessions?boardId=${boardId}` });
  expect(res.statusCode).toBe(200);
  const found = (res.json() as SessionDto[]).find((c) => c.id === id);
  expect(found).toBeTruthy();
  return found!;
}

beforeEach(async () => {
  app = await buildApp();
  // Boards are not part of resetDb's wipe (the server tests seed their own).
  await db.delete(sessionsTable);
  await db.delete(boards);
  const [row] = await db.insert(boards).values({ name: "Board" }).returning();
  boardId = row.id;
});

afterEach(async () => {
  await app.close();
});

useResetDb();

describe("board columns — the four homes", () => {
  it("gives a board from before columns existed exactly today's four lanes", async () => {
    const columns = (await board()).columns;
    expect(columns.map((c) => c.id)).toEqual(["todo", "progress", "wait", "done"]);
    expect(columns.every((c) => c.kind === "stage" && c.home)).toBe(true);
    // The behavior a board already had: Todo and Progress are arranged by
    // hand, Wait is a log of finished turns, Done a log of closed tasks, and
    // the two logs take the next prompt on the card.
    expect(columns.map((c) => c.sortMode)).toEqual(["manual", "manual", "updated", "done"]);
    expect(columns.map((c) => c.acceptsPrompt)).toEqual([false, false, true, true]);
    expect(columns.map((c) => c.title)).toEqual(["", "", "", ""]);
  });

  it("seeds a new board with the same four lanes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { name: "Second" },
    });
    expect(res.statusCode).toBe(200);
    const created = res.json() as BoardDto;
    expect(created.columns.map((c) => c.id)).toEqual(["todo", "progress", "wait", "done"]);
  });

  it("keeps each board's columns to that board", async () => {
    // The stage ids are the same on every board, so the rows must be per board:
    // renaming one board's Wait leaves the other's alone.
    const created = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { name: "Second" },
    });
    const other = created.json() as BoardDto;
    await app.inject({
      method: "PATCH",
      url: `/api/boards/${boardId}/columns/wait`,
      payload: { title: "Ревью" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/columns/order`,
      payload: { ids: ["done", "wait", "progress", "todo"] },
    });

    const res = await app.inject({ method: "GET", url: "/api/boards" });
    const list = res.json() as BoardDto[];
    const mine = list.find((b) => b.id === boardId)!;
    const theirs = list.find((b) => b.id === other.id)!;
    expect(theirs.columns.map((c) => c.id)).toEqual(["todo", "progress", "wait", "done"]);
    expect(theirs.columns.find((c) => c.id === "wait")!.title).toBe("");
    expect(mine.columns.map((c) => c.id)).toEqual(["done", "wait", "progress", "todo"]);
    expect(mine.columns.find((c) => c.id === "wait")!.title).toBe("Ревью");

    // The other board is writable on its own terms: its home takes a rename and
    // its own lane appears beside the four homes rather than replacing them.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/boards/${other.id}/columns/wait`,
      payload: { title: "Ждёт меня" },
    });
    expect(renamed.statusCode).toBe(200);
    const added = await app.inject({
      method: "POST",
      url: `/api/boards/${other.id}/columns`,
      payload: { title: "Ревью" },
    });
    expect(added.statusCode).toBe(200);
    expect((added.json() as BoardDto).columns.map((c) => c.id).slice(0, 4)).toEqual([
      "todo",
      "progress",
      "wait",
      "done",
    ]);
    // ...and this board still shows what it had.
    expect((await board()).columns.map((c) => c.id)).toEqual([
      "done",
      "wait",
      "progress",
      "todo",
    ]);
  });

  it("renames and reorders a home but never deletes it", async () => {
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/boards/${boardId}/columns/wait`,
      payload: { title: "Ревью", acceptsPrompt: false, sortMode: "created" },
    });
    expect(renamed.statusCode).toBe(200);
    const wait = (renamed.json() as BoardDto).columns.find((c) => c.id === "wait")!;
    expect([wait.title, wait.acceptsPrompt, wait.sortMode]).toEqual(["Ревью", false, "created"]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/boards/${boardId}/columns/wait`,
    });
    expect(removed.statusCode).toBe(400);
    expect((await board()).columns.map((c) => c.id)).toContain("wait");

    const reordered = await app.inject({
      method: "PUT",
      url: `/api/boards/${boardId}/columns/order`,
      payload: { ids: ["done", "wait", "progress", "todo"] },
    });
    expect(reordered.statusCode).toBe(200);
    expect((reordered.json() as BoardDto).columns.map((c) => c.id)).toEqual([
      "done",
      "wait",
      "progress",
      "todo",
    ]);
  });
});

describe("board columns — lanes the reader adds", () => {
  it("adds a manual lane after the column it names", async () => {
    const after = await addColumn({ title: "Отложенные", afterId: "todo" });
    const ids = after.columns.map((c) => c.id);
    expect(ids[1]).toMatch(/^col-/);
    const lane = after.columns.find((c) => c.title === "Отложенные")!;
    expect([lane.kind, lane.anchor, lane.home]).toEqual(["manual", null, false]);
  });

  // A column is a place, never a condition: a lane claims no cards by a rule,
  // so the body that would make one has no way in.
  it("refuses a lane that claims cards by a rule", async () => {
    const forTheForm = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/columns`,
      payload: { title: "Ревью", kind: "auto", anchor: "wait", rule: { stage: "wait" } },
    });
    expect(forTheForm.statusCode).toBe(400);
  });

  // What a column *is* does not change: a lane stays a lane, whoever asks.
  it("keeps a lane a lane, whatever the write asks", async () => {
    const created = await addColumn({ title: "Ревью" });
    const lane = created.columns.find((c) => c.title === "Ревью")!;
    const restaged = await app.inject({
      method: "PATCH",
      url: `/api/boards/${boardId}/columns/${lane.id}`,
      payload: { kind: "stage", anchor: "wait" },
    });
    expect(restaged.statusCode).toBe(400);
    const kept = (await board()).columns.find((c) => c.id === lane.id)!;
    expect([kept.kind, kept.anchor, kept.title]).toEqual(["manual", null, "Ревью"]);
  });
});

describe("board columns — placing a card", () => {
  it("keeps a card in the lane the reader dropped it in, however many turns run", async () => {
    const created = await addColumn({ title: "Отложенные" });
    const lane = created.columns.find((c) => c.title === "Отложенные")!;
    expect(lane.keepOnRun).toBe(true);
    const id = await seedTask({ startedAt: new Date() });

    const dropped = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { boardColumnId: lane.id },
    });
    expect(dropped.statusCode).toBe(200);
    expect((dropped.json() as SessionDto).boardColumnId).toBe(lane.id);
    expect((await card(id)).boardColumnId).toBe(lane.id);

    // A claimed turn is the card going back to work — it stays where the hand
    // put it, and Wait never gets it back on its own.
    await claimBoardTaskTurn(id);
    expect((await card(id)).boardColumnId).toBe(lane.id);
  });

  it("hands the card back to the lifecycle in a lane switched to let go", async () => {
    const created = await addColumn({ title: "На ревью" });
    const lane = created.columns.find((c) => c.title === "На ревью")!;
    await app.inject({
      method: "PATCH",
      url: `/api/boards/${boardId}/columns/${lane.id}`,
      payload: { keepOnRun: false },
    });
    const id = await seedTask({ startedAt: new Date() });
    await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { boardColumnId: lane.id },
    });

    await claimBoardTaskTurn(id);
    expect((await card(id)).boardColumnId).toBeNull();
  });

  it("refuses an unknown column, and any column on a plain chat", async () => {
    // A board is seeded with its four homes on its first read, so placing a
    // card on one is accepted.
    await board();
    const id = await seedTask();
    const home = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { boardColumnId: "wait" },
    });
    expect(home.statusCode).toBe(200);
    expect((home.json() as SessionDto).boardColumnId).toBe("wait");

    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { boardColumnId: "col-unknown" },
    });
    expect(unknown.statusCode).toBe(400);

    const chat = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { title: "Chat", provider: "shell", cwd: "/p/app" },
    });
    expect(chat.statusCode).toBe(200);
    const notABoardTask = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${(chat.json() as SessionDto).id}`,
      payload: { boardColumnId: "todo" },
    });
    expect(notABoardTask.statusCode).toBe(400);
  });
});

describe("board columns — deleting a lane", () => {
  it("releases every card standing in it", async () => {
    const created = await addColumn({ title: "Ревью" });
    const lane = created.columns.find((c) => c.title === "Ревью")!;
    const id = await seedTask({ startedAt: new Date() });
    await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { boardColumnId: lane.id },
    });
    expect((await card(id)).boardColumnId).toBe(lane.id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/boards/${boardId}/columns/${lane.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as BoardDto).columns.map((c) => c.id)).not.toContain(lane.id);
    // The card is back on the lifecycle, in the home of its stage.
    expect((await card(id)).boardColumnId).toBeNull();
  });

  it("takes a deleted board's columns with it", async () => {
    await addColumn({ title: "Ревью" });
    const removed = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}` });
    expect(removed.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/boards" });
    expect((res.json() as BoardDto[]).some((b) => b.id === boardId)).toBe(false);
    // Nothing of that board answers a write any more.
    const again = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/columns`,
      payload: { title: "Ревью" },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("board columns — the board row carries them", () => {
  it("hands the columns to every reader of the board list", async () => {
    await addColumn({ title: "Ревью" });
    const first = (await board()).columns.map((c) => c.id);
    const second = (await board()).columns.map((c) => c.id);
    expect(second).toEqual(first);
    // Seeding ran once: the ids are stored, not regenerated per read.
    expect(first.length).toBe(5);
  });
});
