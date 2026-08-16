// Route integration tests: Fastify inject against the isolated acprocess_test
// schema (globalSetup creates it; setup-env pre-wires DATABASE_URL). Covers
// settings, sessions, themes, search, fs, export, diagnostics and agent
// status routes with real inject calls. resetDb() wipes all tables between
// tests; every app instance is closed in afterEach.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp, useResetDb } from "./test-utils.js";
import { db, REPO_ROOT } from "../src/db/client.js";
import {
  sessions as sessionsTable,
  messages as messagesTable,
  messageParts as messagePartsTable,
} from "../src/db/schema.js";
import { disposeRuntime } from "../src/acp/sessionManager.js";

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
  return app.inject({
    method: "PUT",
    url: "/api/settings",
    payload: {
      connectedProvider: "omp",
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

  it("PUT /api/settings rejects an invalid locale (zod throw → 500; the app has no zod error handler)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { locale: "xx" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain("Invalid enum value");
  });
});

describe("sessions", () => {
  it("POST /api/sessions without a connected agent → 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Сначала подключите агента в Настройках");
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

  it("POST export with an invalid format is rejected (zod throw → 500; no zod error handler)", async () => {
    const session = await seedExportSession();
    const dir = await newTempDir("acp-export-");
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/export`,
      payload: { format: "docx", dir },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toContain("Invalid enum value");
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
    expect(res.json()).toEqual({ provider: null, available: false });
  });

  it("GET /api/agent/status with a connected provider reports it", async () => {
    const conn = await connectAgent();
    expect(conn.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/agent/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe("omp");
    // No prompt has ever run in this suite, so the agent is not marked available.
    expect(body.available).toBe(false);
  });
});
