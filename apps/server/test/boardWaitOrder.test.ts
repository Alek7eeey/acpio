// A Wait card's place in the column must follow the agent's own last action,
// not the visit that merely looks at it. Opening a task boots its agent, and
// that boot is a bookkeeping write — it records the harness id and normalizes
// the status — but it used to restamp `updatedAt`, which is precisely the stamp
// the Wait column sorts by: the card flew to the top of the column on being
// opened, with nothing finished behind it.
//
// The assertions run through the doors the report used: the chat is opened with
// GET /api/sessions/:id (the route that warms the agent), the cards come from
// GET /api/sessions?boardId=… (the board's own list), and the order is read the
// way the board page reads the column.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { boardColumn, type SessionDto } from "@acpio/shared";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { boards, sessions as sessionsTable } from "../src/db/schema.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

let app: FastifyInstance;
let boardId: string;
const sessionIds: string[] = [];
const tempDirs: string[] = [];

/** Point the omp adapter at the deterministic fake agent. */
async function connectAgent() {
  setAgentAvailable("omp", true);
  await app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      connectedProvider: "omp",
      defaultProvider: "omp",
      ompCommand: process.execPath,
      ompArgs: [FAKE_AGENT],
    },
  });
}

/**
 * A board task resting in Wait: its first turn ran (`startedAt`) and ended at
 * `finishedAt` — the moment the row's activity stamp carries, as the board's
 * sort reads it.
 */
async function seedWaitTask(title: string, finishedAt: Date): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-board-"));
  tempDirs.push(cwd);
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title,
      provider: "omp",
      cwd,
      mode: "agent",
      status: "idle",
      boardId,
      startedAt: new Date(finishedAt.getTime() - 60_000),
      createdAt: new Date(finishedAt.getTime() - 120_000),
      updatedAt: finishedAt,
    })
    .returning();
  sessionIds.push(row.id);
  return row.id;
}

async function boardCards(): Promise<SessionDto[]> {
  const res = await app.inject({ method: "GET", url: `/api/sessions?boardId=${boardId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as SessionDto[];
}

function cardOf(cards: SessionDto[], id: string): SessionDto {
  const card = cards.find((c) => c.id === id);
  expect(card).toBeTruthy();
  return card!;
}

/** The Wait column as the board page builds it: most recently finished on top. */
function waitOrder(cards: SessionDto[]): string[] {
  return cards
    .filter((card) => boardColumn(card) === "wait")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map((card) => card.title);
}

/** Poll the board's list until the card matches — warm-up runs fire-and-forget
 *  inside the route handler, so there is no promise to await. */
async function waitForCard(
  id: string,
  done: (card: SessionDto) => boolean,
  timeoutMs = 5000,
): Promise<SessionDto> {
  const deadline = Date.now() + timeoutMs;
  let last: SessionDto | null = null;
  while (Date.now() < deadline) {
    last = cardOf(await boardCards(), id);
    if (done(last)) return last;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`card condition not met within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

/** Poll the turn endpoint until the agent's answer has ended. */
async function waitForTurnEnd(sessionId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/turn` });
    if (res.statusCode === 200 && !(res.json() as { running?: boolean }).running) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  throw new Error(`turn did not finish within ${timeoutMs}ms`);
}

beforeEach(async () => {
  app = await buildApp();
  const [board] = await db.insert(boards).values({ name: "Board" }).returning();
  boardId = board.id;
});
useResetDb();
afterEach(async () => {
  for (const id of sessionIds.splice(0)) {
    try {
      disposeRuntime(id);
    } catch {
      // runtime may already be gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await app.close();
});

describe("the Wait column's order", () => {
  it("keeps a card where it is when its chat is merely opened", async () => {
    await connectAgent();
    const older = await seedWaitTask("старая работа", new Date(Date.now() - 3_600_000));
    await seedWaitTask("свежая работа", new Date(Date.now() - 1_800_000));
    const before = cardOf(await boardCards(), older);
    expect(waitOrder(await boardCards())).toEqual(["свежая работа", "старая работа"]);

    // The visit the report is about: opening the chat from the board.
    const opened = await app.inject({ method: "GET", url: `/api/sessions/${older}` });
    expect(opened.statusCode).toBe(200);

    // The visit really did boot the agent and write the row — without this the
    // check would pass on an unvisited card for the wrong reason.
    const booted = await waitForCard(older, (card) => Boolean(card.acpSessionId));
    expect(booted.status).toBe("idle");

    const after = cardOf(await boardCards(), older);
    // Nothing the agent did moved the stamp the column orders by...
    expect(after.updatedAt).toBe(before.updatedAt);
    // ...so the card is still in the same place, second in Wait.
    expect(waitOrder(await boardCards())).toEqual(["свежая работа", "старая работа"]);
  });

  it("moves a card when the agent itself works on it", async () => {
    await connectAgent();
    const older = await seedWaitTask("старая работа", new Date(Date.now() - 3_600_000));
    await seedWaitTask("свежая работа", new Date(Date.now() - 1_800_000));
    const before = cardOf(await boardCards(), older);

    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${older}/prompt`,
      payload: { text: "продолжай" },
    });
    expect(prompt.statusCode).toBe(200);
    await waitForTurnEnd(older);

    const after = cardOf(await boardCards(), older);
    // The turn that just ended is the agent's last action: it outranks the
    // card whose turn ended half an hour earlier.
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(waitOrder(await boardCards())).toEqual(["старая работа", "свежая работа"]);
  });
});