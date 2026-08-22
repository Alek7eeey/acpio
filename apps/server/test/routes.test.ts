// Route integration tests: Fastify inject against an isolated in-memory
// SQLite DB (setup-env pre-wires DATABASE_PATH=":memory:"; buildApp boots the
// schema). Covers settings, sessions, themes, search, fs, export, diagnostics
// and agent status routes with real inject calls. resetDb() wipes all tables
// between tests; every app instance is closed in afterEach.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp, useResetDb } from "./test-utils.js";
import { db, REPO_ROOT } from "../src/db/client.js";
import {
  sessions as sessionsTable,
  messages as messagesTable,
  messageParts as messagePartsTable,
} from "../src/db/schema.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";
import { appendPart, appendTextChunk, createMessage } from "../src/services/sessions.js";

/** Deterministic fake ACP agent; wired as the omp command so session warm-up
 *  connects to it instead of a real harness. */
const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const UNKNOWN_UUID = "00000000-0000-0000-0000-000000000000";

let app: FastifyInstance;
/** Session ids whose ACP runtime (fake agent process) must be disposed. */
const runtimeSessionIds: string[] = [];
const tempDirs: string[] = [];

/** PUT /api/settings {connectedProvider:'omp'} pointing at the fake agent. */
function connectAgent() {
  setAgentAvailable("omp", true);
  return app.inject({
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

/** Insert a session row directly (no agent involved). */
async function seedSession(opts: { title?: string; createdAt?: Date } = {}) {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: opts.title ?? "Seeded session",
      provider: "omp",
      cwd: "",
      mode: "agent",
      ...(opts.createdAt
        ? { createdAt: opts.createdAt, updatedAt: opts.createdAt }
        : {}),
    })
    .returning();
  return row;
}

async function newTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Poll GET /api/sessions/:id until fake-agent warm-up recorded acpSessionId.
 *  The warm-up runs fire-and-forget inside the route handler, so no promise is
 *  exposed to await; observing the spawned child process requires a real-time
 *  poll (fake timers cannot advance a real process). */
async function waitForAcpSessionId(sessionId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (res.statusCode === 200) {
      const body = res.json() as { acpSessionId?: string | null };
      if (body.acpSessionId) return body;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`acpSessionId not set within ${timeoutMs}ms`);
}

beforeEach(async () => {
  app = await buildApp();
});
useResetDb();
afterEach(async () => {
  for (const id of runtimeSessionIds.splice(0)) {
    try {
      disposeRuntime(id);
    } catch {
      // best effort — runtime may already be gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await app.close();
});

describe("health & settings", () => {
  it("GET /api/health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("GET /api/export/default-dir returns the exports folder", async () => {
    const res = await app.inject({ method: "GET", url: "/api/export/default-dir" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: path.join(REPO_ROOT, "exports") });
  });

  it("GET /api/settings returns defaults (theme light, locale ru, no provider)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.theme).toBe("light");
    expect(body.locale).toBe("ru");
    expect(body.connectedProvider).toBeNull();
    expect(body.defaultProvider).toBe("cursor");
    expect(body.ompCommand).toBe("omp");
  });

  it("PUT /api/settings persists changes and GET reflects them", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { theme: "dark", locale: "en", displayName: "Tester" },
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json();
    expect(saved.theme).toBe("dark");
    expect(saved.locale).toBe("en");
    expect(saved.displayName).toBe("Tester");

    const get = await app.inject({ method: "GET", url: "/api/settings" });
    expect(get.statusCode).toBe(200);
    expect(get.json().theme).toBe("dark");
    expect(get.json().locale).toBe("en");
    expect(get.json().displayName).toBe("Tester");
  });

  it("optional remote access key is skipped on localhost and empty key", async () => {
    const lan = { host: "192.168.1.9:5173" };
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: lan })).statusCode).toBe(
      200,
    );
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { remoteAccessKey: "SECRET42" },
    });
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/health", headers: lan })).statusCode,
    ).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/api/settings", headers: lan });
    expect(blocked.statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/api/remote-access", headers: lan });
    expect(status.json()).toEqual({ required: true, unlocked: false });
    const bad = await app.inject({
      method: "POST",
      url: "/api/remote-access",
      headers: lan,
      payload: { key: "nope" },
    });
    expect(bad.statusCode).toBe(401);
    const unlock = await app.inject({
      method: "POST",
      url: "/api/remote-access",
      headers: lan,
      payload: { key: "SECRET42" },
    });
    expect(unlock.statusCode).toBe(200);
    const cookie = unlock.cookies.find((c) => c.name === "acp_remote");
    expect(cookie?.value).toBe("SECRET42");
    const ok = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: lan,
      cookies: { acp_remote: "SECRET42" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("PUT /api/settings rejects an invalid locale with 400 (zod → error handler)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { locale: "xx" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid enum value");
  });
});

describe("sessions", () => {
  it("POST /api/sessions without a reachable agent → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Агент этого чата сейчас недоступен на этом компьютере");
  });

  it("POST /api/sessions with connected agent → 200 with id; detail shows warmed acpSessionId", async () => {
    const conn = await connectAgent();
    expect(conn.statusCode).toBe(200);

    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(200);
    const session = res.json();
    expect(session.id).toBeTruthy();
    expect(session.title).toBe("Новый чат");
    expect(session.provider).toBe("omp");
    expect(session.mode).toBe("agent");
    expect(session.pinned).toBe(false);
    expect(session.archived).toBe(false);
    runtimeSessionIds.push(session.id);

    const detail = await waitForAcpSessionId(session.id);
    expect(detail.acpSessionId).toMatch(/^fake-sess-/);
    expect(detail.messages).toEqual([]);
    expect(detail.slashCommands).toEqual([]);
  });

  it("keeps reasoning phases as separate thought parts interleaved with tools", async () => {
    const conn = await connectAgent();
    expect(conn.statusCode).toBe(200);
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const session = res.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "PHASED: разбей рассуждения" },
    });
    expect(prompt.statusCode).toBe(200);

    // Fake agent answers instantly — wait for the turn to finish (real child
    // process, so poll like waitForAcpSessionId instead of fake timers).
    const deadline = Date.now() + 5000;
    let detail;
    while (Date.now() < deadline) {
      const d = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
      detail = d.json();
      if (detail.status === "idle" && detail.messages.some((m: { role: string }) => m.role === "assistant")) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
    const assistant = detail!.messages.find((m: { role: string }) => m.role === "assistant");
    const parts = assistant!.parts;
    const thoughts = parts.filter((p: { type: string }) => p.type === "thought");
    const tools = parts.filter((p: { type: string }) => p.type === "tool_call");
    expect(thoughts.map((p: { payload: { text?: string } }) => p.payload.text)).toEqual([
      "phase one thinking",
      "phase two thinking",
    ]);
    expect(tools).toHaveLength(1);
    const order = parts.map((p: { type: string }) => p.type);
    // thought → tool → thought: the second phase is NOT merged into the first.
    expect(order.indexOf("thought")).toBeLessThan(order.lastIndexOf("tool_call"));
    expect(order.lastIndexOf("tool_call")).toBeLessThan(order.lastIndexOf("thought"));
    // A completed prompt marks the provider available process-wide; restore the
    // suite's "no prompt yet" state for the agent status tests.
    setAgentAvailable("omp", false);
  });

  it("GET /api/sessions lists seeded sessions", async () => {
    const seeded = await seedSession({ title: "List me" });
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    const hit = list.find((s: { id: string }) => s.id === seeded.id);
    expect(hit).toBeTruthy();
    expect(hit.title).toBe("List me");
    expect(hit.mode).toBe("agent");
  });

  it("GET /api/sessions/:id returns session detail with empty messages", async () => {
    const seeded = await seedSession({ title: "Detail session" });
    const res = await app.inject({ method: "GET", url: `/api/sessions/${seeded.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(seeded.id);
    expect(body.title).toBe("Detail session");
    expect(body.messages).toEqual([]);
  });

  it("GET /api/sessions/:id with unknown id → 404", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /api/sessions/:id updates title, pinned and archived", async () => {
    const seeded = await seedSession({ title: "Before" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${seeded.id}`,
      payload: { title: "After", pinned: true, archived: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe("After");
    expect(body.pinned).toBe(true);
    expect(body.archived).toBe(true);

    const after = await app.inject({ method: "GET", url: `/api/sessions/${seeded.id}` });
    expect(after.json().title).toBe("After");
    expect(after.json().pinned).toBe(true);
    expect(after.json().archived).toBe(true);
  });

  it("PATCH /api/sessions/:id with unknown id → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${UNKNOWN_UUID}`,
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /api/sessions/:id persists per-chat MCP disabled ids", async () => {
    const seeded = await seedSession({ title: "MCP chat" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${seeded.id}`,
      payload: { mcpDisabledIds: ["mcp-a", "mcp-b"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mcpDisabledIds).toEqual(["mcp-a", "mcp-b"]);

    const after = await app.inject({ method: "GET", url: `/api/sessions/${seeded.id}` });
    expect(after.json().mcpDisabledIds).toEqual(["mcp-a", "mcp-b"]);

    // clearing works too
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${seeded.id}`,
      payload: { mcpDisabledIds: [] },
    });
    expect(cleared.json().mcpDisabledIds).toEqual([]);
  });

  it("DELETE /api/sessions/:id removes the session; re-fetch → 404", async () => {
    const seeded = await seedSession({ title: "Delete me" });
    const del = await app.inject({ method: "DELETE", url: `/api/sessions/${seeded.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const get = await app.inject({ method: "GET", url: `/api/sessions/${seeded.id}` });
    expect(get.statusCode).toBe(404);
  });

  it("DELETE /api/sessions/:id with unknown id → 404", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /api/sessions/reorder applies the given sort order", async () => {
    const same = new Date("2026-01-01T00:00:00.000Z");
    const a = await seedSession({ title: "A", createdAt: same });
    const b = await seedSession({ title: "B", createdAt: same });

    const res = await app.inject({
      method: "PUT",
      url: "/api/sessions/reorder",
      payload: {
        items: [
          { id: b.id, themeId: null, sortOrder: 0 },
          { id: a.id, themeId: null, sortOrder: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(b.id);
    expect(list[0].sortOrder).toBe(0);
    expect(list[1].id).toBe(a.id);
    expect(list[1].sortOrder).toBe(1);
  });
});

describe("thought dedupe", () => {
  // Long enough to pass the re-emission threshold (>= 40 chars).
  const THINKING =
    "Пользователь спрашивает, как расшифровывается AVS в контексте IPS. Это длинная мысль, которую агент повторяет целиком при возобновлении хода.";

  async function partText(partId: string): Promise<string> {
    const [row] = await db
      .select()
      .from(messagePartsTable)
      .where(eq(messagePartsTable.id, partId));
    return row ? String((row.payload as { text?: unknown }).text ?? "") : "";
  }

  it("skips a full-text re-emission appended to the same streamed thought part", async () => {
    const seeded = await seedSession({ title: "suffix dedupe" });
    const msg = await createMessage(seeded.id, "assistant");
    const id = await appendTextChunk(seeded.id, msg.id, "thought", THINKING, null);
    // Agent resumes reasoning after tools and re-emits the whole block.
    const again = await appendTextChunk(seeded.id, msg.id, "thought", THINKING, id);
    expect(again).toBe(id);
    expect(await partText(id)).toBe(THINKING);
  });

  it("still appends real stream deltas after a skip", async () => {
    const seeded = await seedSession({ title: "deltas after skip" });
    const msg = await createMessage(seeded.id, "assistant");
    const id = await appendTextChunk(seeded.id, msg.id, "thought", THINKING, null);
    await appendTextChunk(seeded.id, msg.id, "thought", THINKING, id); // re-emission → skipped
    await appendTextChunk(seeded.id, msg.id, "thought", " Продолжение", id);
    expect(await partText(id)).toBe(`${THINKING} Продолжение`);
  });

  it("drops a repeated thought in a sibling message with no user input between", async () => {
    const seeded = await seedSession({ title: "sibling dedupe" });
    const msg1 = await createMessage(seeded.id, "assistant");
    await appendTextChunk(seeded.id, msg1.id, "thought", THINKING, null);
    // Replayed/resumed turn lands in a NEW assistant message, no user turn between.
    const msg2 = await createMessage(seeded.id, "assistant");
    await db
      .update(messagesTable)
      .set({ createdAt: new Date("2026-08-17T10:00:01.000Z") })
      .where(eq(messagesTable.id, msg1.id));
    await db
      .update(messagesTable)
      .set({ createdAt: new Date("2026-08-17T10:00:02.000Z") })
      .where(eq(messagesTable.id, msg2.id));
    const anchor = await appendTextChunk(seeded.id, msg2.id, "thought", THINKING, null);
    expect(await partText(anchor)).toBe("");
    const rows = await db
      .select()
      .from(messagePartsTable)
      .where(eq(messagePartsTable.messageId, msg1.id));
    expect(rows).toHaveLength(1);
    expect(await partText(rows[0]!.id)).toBe(THINKING);
  });

  it("keeps a repeated thought when a user message separates the turns", async () => {
    const seeded = await seedSession({ title: "across turns keep" });
    const msg1 = await createMessage(seeded.id, "assistant");
    await appendTextChunk(seeded.id, msg1.id, "thought", THINKING, null);
    const userMsg = await createMessage(seeded.id, "user");
    await appendPart(seeded.id, userMsg.id, "text", { text: "тот же вопрос снова" });
    const msg2 = await createMessage(seeded.id, "assistant");
    await db
      .update(messagesTable)
      .set({ createdAt: new Date("2026-08-17T10:00:01.000Z") })
      .where(eq(messagesTable.id, msg1.id));
    await db
      .update(messagesTable)
      .set({ createdAt: new Date("2026-08-17T10:00:02.000Z") })
      .where(eq(messagesTable.id, userMsg.id));
    await db
      .update(messagesTable)
      .set({ createdAt: new Date("2026-08-17T10:00:03.000Z") })
      .where(eq(messagesTable.id, msg2.id));
    const id = await appendTextChunk(seeded.id, msg2.id, "thought", THINKING, null);
    expect(await partText(id)).toBe(THINKING);
  });

  it("does not dedupe short repeated thoughts", async () => {
    const seeded = await seedSession({ title: "short keep" });
    const msg1 = await createMessage(seeded.id, "assistant");
    await appendTextChunk(seeded.id, msg1.id, "thought", "хм", null);
    const msg2 = await createMessage(seeded.id, "assistant");
    const id = await appendTextChunk(seeded.id, msg2.id, "thought", "хм", null);
    expect(await partText(id)).toBe("хм");
  });
});

describe("themes", () => {
  it("GET /api/themes returns an empty list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/themes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("POST /api/themes with a name creates a theme", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Midnight" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("Midnight");
    expect(body.sortOrder).toBe(0);
  });

  it("POST /api/themes without a name falls back to the default name", async () => {
    const res = await app.inject({ method: "POST", url: "/api/themes", payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.name).toBe("string");
    expect(body.name.length).toBeGreaterThan(0);
  });

  it("PATCH /api/themes/:id renames the theme", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Old name" },
    });
    const themeId = created.json().id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/themes/${themeId}`,
      payload: { name: "New name" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("New name");

    const list = await app.inject({ method: "GET", url: "/api/themes" });
    expect(list.json()[0].name).toBe("New name");
  });

  it("PATCH /api/themes/:id with unknown id → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/themes/${UNKNOWN_UUID}`,
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /api/themes/:id removes the theme", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/themes",
      payload: { name: "Doomed" },
    });
    const themeId = created.json().id;
    const del = await app.inject({ method: "DELETE", url: `/api/themes/${themeId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const list = await app.inject({ method: "GET", url: "/api/themes" });
    expect(list.json()).toEqual([]);
  });

  it("DELETE /api/themes/:id with unknown id → 404", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/themes/${UNKNOWN_UUID}` });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /api/themes/reorder applies the given order", async () => {
    const created: string[] = [];
    for (const name of ["First", "Second", "Third"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/themes",
        payload: { name },
      });
      created.push(res.json().id);
    }
    const [first, second, third] = created;
    const wanted = [third, first, second];
    const res = await app.inject({
      method: "PUT",
      url: "/api/themes/reorder",
      payload: { ids: wanted },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.map((t: { id: string }) => t.id)).toEqual(wanted);
    expect(list.map((t: { sortOrder: number }) => t.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe("search", () => {
  it("GET /api/search finds a seeded user message part", async () => {
    const session = await seedSession({ title: "Search target" });
    const [msg] = await db
      .insert(messagesTable)
      .values({ sessionId: session.id, role: "user" })
      .returning();
    await db.insert(messagePartsTable).values({
      messageId: msg.id,
      type: "text",
      payload: { text: "The quick brown fox jumps over the lazy dog" },
    });

    const res = await app.inject({ method: "GET", url: "/api/search?q=fox" });
    expect(res.statusCode).toBe(200);
    const hits = res.json();
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((h: { sessionId: string }) => h.sessionId === session.id);
    expect(hit).toBeTruthy();
    expect(hit.sessionTitle).toBe("Search target");
    expect(hit.role).toBe("user");
    expect(hit.snippet).toContain("fox");
  });

  it.each([
    ["an unmatched query", "zzzzz-no-such-word"],
    ["an empty query", ""],
  ])("GET /api/search with %s returns no hits", async (_label, q) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/search?q=${encodeURIComponent(q)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("fs", () => {
  it("POST /api/fs/mkdir creates the directory on disk", async () => {
    const base = await newTempDir("acp-mkdir-");
    const target = path.join(base, "nested", "child");
    const res = await app.inject({
      method: "POST",
      url: "/api/fs/mkdir",
      payload: { path: target },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, path: target });
    await expect(fsp.access(target)).resolves.toBeUndefined();
  });

  it("GET /api/fs/browse lists a temp directory", async () => {
    const base = await newTempDir("acp-browse-");
    await fsp.mkdir(path.join(base, "subdir"));
    const res = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(base)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(path.resolve(base));
    expect(body.kind).toBe("directory");
    const entry = body.entries.find((e: { name: string }) => e.name === "subdir");
    expect(entry).toBeTruthy();
    expect(entry.isDir).toBe(true);
  });

  it("POST /api/fs/browse lists a temp directory", async () => {
    const base = await newTempDir("acp-browse-");
    await fsp.mkdir(path.join(base, "subdir"));
    const res = await app.inject({
      method: "POST",
      url: "/api/fs/browse",
      payload: { path: base },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(path.resolve(base));
    expect(body.entries.some((e: { name: string }) => e.name === "subdir")).toBe(true);
  });

  it("GET /api/fs/browse with a missing path → 400", async () => {
    const base = await newTempDir("acp-browse-");
    const res = await app.inject({
      method: "GET",
      url: `/api/fs/browse?path=${encodeURIComponent(path.join(base, "nope"))}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Path not found");
  });

  it("POST /api/fs/open on an existing directory → ok", async () => {
    const base = await newTempDir("acp-open-");
    const res = await app.inject({
      method: "POST",
      url: "/api/fs/open",
      payload: { path: base },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, opened: base, kind: "directory" });
  });

  it("POST /api/fs/open with a missing path → 400", async () => {
    const base = await newTempDir("acp-open-");
    const res = await app.inject({
      method: "POST",
      url: "/api/fs/open",
      payload: { path: path.join(base, "does-not-exist") },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("path does not exist");
  });
});

describe("export", () => {
  const EXPORT_TITLE = "Экспорт тест";

  async function seedExportSession() {
    const [row] = await db
      .insert(sessionsTable)
      .values({ title: EXPORT_TITLE, provider: "omp", cwd: "", mode: "agent" })
      .returning();
    return row;
  }

  it("GET export as markdown → 200 with markdown content-type and UTF-8 attachment header", async () => {
    const session = await seedExportSession();
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/export?format=md`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    const cd = res.headers["content-disposition"] as string;
    expect(cd).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("''")[1] as string)).toContain(EXPORT_TITLE);
    expect(res.body).toContain(EXPORT_TITLE);
  });

  it("GET export as json → 200 with json content-type and title in body", async () => {
    const session = await seedExportSession();
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/export?format=json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-disposition"] as string).toMatch(/^attachment; filename\*=UTF-8''/);
    const body = res.json();
    expect(body.format).toBe("acprocess-chat");
    expect(body.session.title).toBe(EXPORT_TITLE);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("GET export for an unknown session → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${UNKNOWN_UUID}/export?format=md`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST export saves a file; a second export of the same title gets a -2 suffix", async () => {
    const session = await seedExportSession();
    const dir = await newTempDir("acp-export-");

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/export`,
      payload: { format: "md", dir },
    });
    expect(first.statusCode).toBe(200);
    const b1 = first.json();
    expect(b1.ok).toBe(true);
    expect(b1.fileName).toMatch(/\.md$/);
    expect(b1.path).toBe(path.join(path.resolve(dir), b1.fileName));
    await fsp.access(b1.path);

    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/export`,
      payload: { format: "md", dir },
    });
    expect(second.statusCode).toBe(200);
    const b2 = second.json();
    expect(b2.fileName).toMatch(/-2\.md$/);
    await fsp.access(b2.path);
  });

  it("POST export with an invalid format is rejected with 400 (zod → error handler)", async () => {
    const session = await seedExportSession();
    const dir = await newTempDir("acp-export-");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/export`,
      payload: { format: "docx", dir },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid enum value");
  });
});

describe("diagnostics", () => {
  async function setupDiagDir(): Promise<string> {
    const dir = await newTempDir("acp-diag-");
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { diagnosticsDir: dir },
    });
    expect(res.statusCode).toBe(200);
    return dir;
  }

  it("GET /api/diagnostics/default-dir returns a path", async () => {
    const res = await app.inject({ method: "GET", url: "/api/diagnostics/default-dir" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().path).toBe("string");
    expect(res.json().path.length).toBeGreaterThan(0);
  });

  it("POST /api/diagnostics/dump writes a dump file and returns metadata", async () => {
    const dir = await setupDiagDir();
    const res = await app.inject({
      method: "POST",
      url: "/api/diagnostics/dump",
      payload: { reason: "routes-test", note: "integration probe" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.dump.reason).toBe("routes-test");
    expect(body.dump.fileName).toMatch(/^acprocess-dump-.*\.json$/);
    expect(body.dump.size).toBeGreaterThan(0);
    expect(body.dump.path.startsWith(path.resolve(dir))).toBe(true);
    await fsp.access(body.dump.path);
  });

  it("GET /api/diagnostics lists the written dump", async () => {
    const dir = await setupDiagDir();
    const dumped = await app.inject({
      method: "POST",
      url: "/api/diagnostics/dump",
      payload: { reason: "routes-list" },
    });
    const dumpId = dumped.json().dump.id;

    const res = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dir).toBe(path.resolve(dir));
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].id).toBe(dumpId);
    expect(body.items[0].fileName).toMatch(/\.json$/);
  });

  it("GET /api/diagnostics/:id returns the dump payload", async () => {
    await setupDiagDir();
    const dumped = await app.inject({
      method: "POST",
      url: "/api/diagnostics/dump",
      payload: { reason: "routes-get" },
    });
    const dumpId = dumped.json().dump.id;

    const res = await app.inject({ method: "GET", url: `/api/diagnostics/${dumpId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(dumpId);
    expect(body.payload.version).toBe(1);
    expect(body.payload.reason).toBe("routes-get");
    expect(body.payload.note).toBeUndefined();
  });

  it("DELETE /api/diagnostics/:id removes the dump; re-fetch → 404", async () => {
    await setupDiagDir();
    const dumped = await app.inject({
      method: "POST",
      url: "/api/diagnostics/dump",
      payload: { reason: "routes-del" },
    });
    const dumpId = dumped.json().dump.id;

    const del = await app.inject({ method: "DELETE", url: `/api/diagnostics/${dumpId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const get = await app.inject({ method: "GET", url: `/api/diagnostics/${dumpId}` });
    expect(get.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(list.json().items).toEqual([]);
  });

  it("DELETE /api/diagnostics/:id with unknown id → 404", async () => {
    await setupDiagDir();
    const res = await app.inject({ method: "DELETE", url: `/api/diagnostics/nope` });
    expect(res.statusCode).toBe(404);
  });
});

describe("agent status", () => {
  it("GET /api/agent/status without a connected provider → provider null, available false", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: null,
      available: false,
      availability: { cursor: false, omp: false },
    });
  });

  it("GET /api/agent/status with a connected provider reports it", async () => {
    const conn = await connectAgent();
    expect(conn.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/agent/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("omp");
    expect(body.available).toBe(true);
    expect(body.availability.omp).toBe(true);
  });
});
