// Route integration tests: Fastify inject against an isolated in-memory
// SQLite DB (setup-env pre-wires DATABASE_PATH=":memory:"; buildApp boots the
// schema). Covers settings, sessions, themes, search, fs, export, diagnostics
// and agent status routes with real inject calls. resetDb() wipes all tables
// between tests; every app instance is closed in afterEach.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import http from "node:http";
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
  settings as settingsTable,
} from "../src/db/schema.js";
import { disposeRuntime, setAgentAvailable } from "../src/acp/sessionManager.js";
import { clearModelRegistryCache } from "../src/services/modelRegistry.js";
import {
  appendPart,
  appendTextChunk,
  createMessage,
  reconcileStaleSessions,
} from "../src/services/sessions.js";
import type { GitCommitDetailDto, GitCommitDto, GitStatusDto, MessagePartDto, SessionDetailDto } from "@acpio/shared";

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
async function seedSession(opts: { title?: string; createdAt?: Date; cwd?: string } = {}) {
  const [row] = await db
    .insert(sessionsTable)
    .values({
      title: opts.title ?? "Seeded session",
      provider: "omp",
      cwd: opts.cwd ?? "",
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

/** Poll GET /api/sessions/:id/turn until the agent turn finishes. The prompt
 *  route is fire-and-forget and exposes no turn-end promise, so a real-time
 *  poll is the only probe (same reason as waitForAcpSessionId above). */
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
    expect(res.json()).toEqual({ ok: true, platform: process.platform });
  });

  it("GET /api/export/default-dir returns the exports folder", async () => {
    const res = await app.inject({ method: "GET", url: "/api/export/default-dir" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: path.join(REPO_ROOT, "exports") });
  });

  it("GET /api/settings returns defaults (theme light, locale en, no provider)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.theme).toBe("light");
    expect(body.locale).toBe("en");
    expect(body.connectedProvider).toBeNull();
    expect(body.defaultProvider).toBe("cursor");
    expect(body.ompCommand).toBe("omp");
    expect(body.remoteAccessKey).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
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

  it("PUT /api/settings persists composer layout settings", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { chatGitBranchPosition: "above", chatChipOptions: { folder: { compress: false } } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().chatGitBranchPosition).toBe("above");
    expect(put.json().chatChipOptions.folder).toEqual({ compress: false, truncate: "middle" });

    const get = await app.inject({ method: "GET", url: "/api/settings" });
    expect(get.statusCode).toBe(200);
    expect(get.json().chatGitBranchPosition).toBe("above");
    expect(get.json().chatChipOptions.folder).toEqual({ compress: false, truncate: "middle" });
  });

  // Regression: the field was missing from the PUT schema, so zod stripped it
  // and the board placeholder picker snapped back after every save.
  it("PUT /api/settings persists the board add-task placeholder style", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { boardAddCardStyle: "compact" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().boardAddCardStyle).toBe("compact");

    const get = await app.inject({ method: "GET", url: "/api/settings" });
    expect(get.statusCode).toBe(200);
    expect(get.json().boardAddCardStyle).toBe("compact");
  });

  it("PUT /api/settings keeps the other chips when patching one", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { chatChipOptions: { gitChanges: { metrics: "none" } } },
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { chatChipOptions: { context: { format: "percent" } } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().chatChipOptions).toEqual({
      folder: { compress: true, truncate: "middle" },
      gitBranch: { compress: true },
      gitChanges: { compress: true, metrics: "none" },
      context: { format: "percent" },
    });
  });

  it("PUT /api/settings stores per-folder MCP switches under a canonical cwd", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        mcpServers: [
          { id: "global", name: "Global", enabled: true, type: "local", url: "http://127.0.0.1:9" },
          { id: "off", name: "Off", enabled: false, type: "local", url: "http://127.0.0.1:8" },
        ],
        mcpFolderConfigs: {
          "E:\\proj\\": {
            overrides: { global: false, off: true },
            servers: [{ id: "own", name: "Own", enabled: true, type: "stdio", command: "npx" }],
          },
        },
      },
    });
    expect(put.statusCode).toBe(200);

    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    // `E:\proj\` and `E:/proj` are the same folder: one canonical key.
    expect(Object.keys(body.mcpFolderConfigs)).toEqual(["E:/proj"]);
    // A folder switches a global server off and a globally off one back on.
    expect(body.mcpFolderConfigs["E:/proj"].overrides).toEqual({ global: false, off: true });
    expect(body.mcpFolderConfigs["E:/proj"].servers[0]).toMatchObject({
      id: "own",
      type: "stdio",
      command: "npx",
    });
  });

  it("drops a folder override that no longer overrides anything", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        mcpFolderConfigs: {
          "E:/empty": { overrides: {}, servers: [] },
          "E:/kept": { overrides: { x: false }, servers: [] },
        },
      },
    });
    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.mcpFolderConfigs).toEqual({
      "E:/kept": { overrides: { x: false }, servers: [] },
    });
  });

  it("heals a stored folder override saved before the cwd/row rules", async () => {
    await db.insert(settingsTable).values({
      key: "app",
      value: {
        mcpFolderConfigs: {
          "E:\\legacy\\": {
            // A pre-tri-state row stored switched-off ids as a plain list.
            disabledIds: ["ok", 7],
            overrides: { on: true, bad: "yes" },
            servers: [{ nope: true }, { id: "s", name: "S", enabled: true, type: "stdio", command: " npx " }],
          },
        },
      },
    });
    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.mcpFolderConfigs["E:/legacy"].overrides).toEqual({ on: true, ok: false });
    expect(body.mcpFolderConfigs["E:/legacy"].servers.map((s: { id: string }) => s.id)).toEqual(["s"]);
  });

  it("heals mcpProjectFiles to relative paths, keeping an empty list empty", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        mcpProjectFiles: [" .cursor\\mcp.json ", "C:/outside/mcp.json", "../escape/mcp.json", ".omp/mcp.json"],
      },
    });
    expect(put.statusCode).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.mcpProjectFiles).toEqual([".cursor/mcp.json", ".omp/mcp.json"]);

    await app.inject({ method: "PUT", url: "/api/settings", payload: { mcpProjectFiles: [] } });
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().mcpProjectFiles).toEqual(
      [],
    );
  });

  it("GET /api/mcp/project reads a folder's own MCP files", async () => {
    const cwd = await newTempDir("acpio-mcp-route-");
    await fsp.mkdir(path.join(cwd, ".omp"), { recursive: true });
    await fsp.mkdir(path.join(cwd, ".cursor"), { recursive: true });
    await fsp.writeFile(
      path.join(cwd, ".omp", "mcp.json"),
      '{"mcpServers":{"fs":{"command":"npx","args":["-y","mcp-fs"]}}}',
      "utf8",
    );
    await fsp.writeFile(path.join(cwd, ".cursor", "mcp.json"), "{oops", "utf8");

    const res = await app.inject({
      method: "GET",
      url: `/api/mcp/project?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      folders: Record<string, { servers: unknown[]; warnings: string[] }>;
    };
    const key = cwd.replace(/\\/g, "/");
    expect(body.folders[key]).toEqual({
      servers: [
        {
          id: "file:.omp/mcp.json:fs",
          name: "fs",
          enabled: true,
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-fs"],
        },
      ],
      warnings: [".cursor/mcp.json: invalid JSON"],
    });

    // Clearing the file list stops folder files contributing entirely.
    await app.inject({ method: "PUT", url: "/api/settings", payload: { mcpProjectFiles: [] } });
    const cleared = (
      await app.inject({ method: "GET", url: `/api/mcp/project?cwd=${encodeURIComponent(cwd)}` })
    ).json() as { folders: Record<string, unknown> };
    expect(cleared.folders[key]).toEqual({ servers: [], warnings: [] });
  });

  it("DELETE /api/folders drops the folder's MCP override with it", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { mcpFolderConfigs: { "E:/gone": { overrides: { x: false }, servers: [] } } },
    });
    const del = await app.inject({ method: "DELETE", url: "/api/folders?cwd=E:/gone" });
    expect(del.statusCode).toBe(200);
    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.mcpFolderConfigs).toEqual({});
  });

  it("generates a remote access key by default; LAN needs it until explicitly cleared", async () => {
    const lan = {
      host: "192.168.1.9:18751",
      "x-forwarded-for": "192.168.1.50",
    };
    const seeded = await app.inject({ method: "GET", url: "/api/settings" });
    expect(seeded.statusCode).toBe(200);
    const key = seeded.json().remoteAccessKey as string;
    expect(key).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: lan })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: lan })).statusCode).toBe(
      401,
    );
    const status = await app.inject({ method: "GET", url: "/api/remote-access", headers: lan });
    expect(status.json()).toEqual({ required: true, unlocked: false });
    const unlock = await app.inject({
      method: "POST",
      url: "/api/remote-access",
      headers: lan,
      payload: { key },
    });
    expect(unlock.statusCode).toBe(200);
    const cookie = unlock.cookies.find((c) => c.name === "acp_remote");
    expect(cookie?.value).toBe(key);
    const ok = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: lan,
      cookies: { acp_remote: key },
    });
    expect(ok.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { remoteAccessKey: "" },
    });
    expect((await app.inject({ method: "GET", url: "/api/settings", headers: lan })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().remoteAccessKey).toBe(
      "",
    );

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { remoteAccessKey: "SECRET42" },
    });
    const blocked = await app.inject({ method: "GET", url: "/api/settings", headers: lan });
    expect(blocked.statusCode).toBe(401);
    const custom = await app.inject({
      method: "POST",
      url: "/api/remote-access",
      headers: lan,
      payload: { key: "SECRET42" },
    });
    expect(custom.statusCode).toBe(200);
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
    expect(res.json().error).toBe("This chat's agent is not running on this PC");
  });

  it("POST /api/sessions with connected agent → 200 with id; detail shows warmed acpSessionId", async () => {
    const conn = await connectAgent();
    expect(conn.statusCode).toBe(200);

    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(res.statusCode).toBe(200);
    const session = res.json();
    expect(session.id).toBeTruthy();
    expect(session.title).toBe("New chat");
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

  it("pins the chat's starting model and keeps it when the default moves", async () => {
    await connectAgent();
    const setDefault = (model: string) =>
      app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { defaultModelByProvider: { omp: model } },
      });

    await setDefault("model-a");
    const first = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(first.json().model).toBe("model-a");
    runtimeSessionIds.push(first.json().id);

    // Picking a model in another chat moves the harness default; the chat that
    // started on "model-a" must keep running on it.
    await setDefault("model-b");
    const second = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(second.json().model).toBe("model-b");
    runtimeSessionIds.push(second.json().id);

    const list: SessionDetailDto[] = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(list.find((s) => s.id === first.json().id)?.model).toBe("model-a");

    // Console chats have no agent model to pin.
    const shell = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { provider: "shell" },
    });
    expect(shell.json().model).toBe("");
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
    expect(body.format).toBe("acpio-chat");
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

describe("bulk export", () => {
  /** Chat of one provider with a user message carrying one text part. */
  async function seedChat(provider: string, title: string, text?: string) {
    const [row] = await db
      .insert(sessionsTable)
      .values({ title, provider, cwd: "", mode: "agent" })
      .returning();
    if (text !== undefined) {
      const message = await createMessage(row.id, "user");
      await appendPart(row.id, message.id, "text", { text });
    }
    return row;
  }

  it("GET /api/export/chats bundles every builtin chat and skips other providers", async () => {
    const mine = await seedChat("builtin", "Агентский чат", "привет");
    await seedChat("builtin", "Пустой");
    await seedChat("omp", "Чужой", "не builtin");

    const res = await app.inject({ method: "GET", url: "/api/export/chats" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    const cd = res.headers["content-disposition"] as string;
    expect(decodeURIComponent(cd.split("''")[1] as string)).toMatch(/^acpio-builtin-chats-\d{4}-\d{2}-\d{2}\.json$/);

    const body = res.json();
    expect(body.format).toBe("acpio-chats");
    expect(body.chatCount).toBe(2);
    expect(body.messageCount).toBe(1);
    const titles = (body.chats as Array<{ session: { title: string } }>).map((c) => c.session.title);
    expect(titles).toContain("Агентский чат");
    expect(titles).toContain("Пустой");
    expect(titles).not.toContain("Чужой");
    expect((body.chats as Array<{ session: { id: string } }>)[0].session.id).toBeTruthy();
    expect(mine.id).toBeTruthy();
  });

  it("GET /api/export/chats?provider=omp switches the population", async () => {
    await seedChat("builtin", "Агентский чат");
    await seedChat("omp", "Чужой");

    const res = await app.inject({ method: "GET", url: "/api/export/chats?provider=omp" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chatCount).toBe(1);
    expect(body.chats[0].session.title).toBe("Чужой");
  });

  it("GET on an empty population → 200 with chatCount 0", async () => {
    const res = await app.inject({ method: "GET", url: "/api/export/chats" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ format: "acpio-chats", chatCount: 0, chats: [] });
  });

  it("POST /api/export/chats saves the bundle and reports the chat count", async () => {
    await seedChat("builtin", "Агентский чат", "привет");
    const dir = await newTempDir("acp-bulk-export-");

    const res = await app.inject({
      method: "POST",
      url: "/api/export/chats",
      payload: { dir },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.count).toBe(1);
    expect(body.fileName).toMatch(/^acpio-builtin-chats-\d{4}-\d{2}-\d{2}\.json$/);
    expect(body.path).toBe(path.join(path.resolve(dir), body.fileName));
    const saved = JSON.parse(await fsp.readFile(body.path, "utf8"));
    expect(saved.chatCount).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/api/export/chats",
      payload: { dir },
    });
    expect(second.json().fileName).toMatch(/-2\.json$/);
  });
});

describe("attachment upload", () => {
  const ONE_PIXEL_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  /** Session whose cwd is a fresh temp dir (uploads land under it). */
  async function seedUploadSession() {
    const cwd = await newTempDir("acp-upload-");
    const row = await seedSession();
    await db.update(sessionsTable).set({ cwd }).where(eq(sessionsTable.id, row.id));
    return { id: row.id, cwd };
  }

  function postUpload(sessionId: string, body: Buffer, name: string, mime = "image/png") {
    return app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/attachments/upload`,
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-file-mime": mime,
      },
      payload: body,
    });
  }

  it("stages an octet-stream body under the session attachments folder", async () => {
    const session = await seedUploadSession();
    const res = await postUpload(session.id, ONE_PIXEL_PNG, "Снимок экрана.png");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; path: string; size: number };
    expect(body.name).toBe("Снимок экрана.png");
    expect(body.size).toBe(ONE_PIXEL_PNG.length);
    expect(body.path).toBe(
      path.join(session.cwd, ".acpio-attachments", session.id, "Снимок экрана.png"),
    );
    expect(await fsp.readFile(body.path)).toEqual(ONE_PIXEL_PNG);
  });

  it("accepts a payload far above the instance-wide default body limit", async () => {
    // The parser raises the limit to MAX_ATTACH_UPLOAD_BYTES for this content
    // type; a multi-MB screenshot must not hit Fastify's 1 MB default.
    const session = await seedUploadSession();
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await postUpload(session.id, big, "shot.png");
    expect(res.statusCode).toBe(200);
    expect(res.json().size).toBe(big.length);
  });

  it("rejects a payload above 15 MB with 413", async () => {
    const session = await seedUploadSession();
    const huge = Buffer.alloc(15 * 1024 * 1024 + 1, 7);
    const res = await postUpload(session.id, huge, "huge.png");
    expect(res.statusCode).toBe(413);
  });

  it("rejects a body without a file name with 400", async () => {
    const session = await seedUploadSession();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments/upload`,
      headers: { "content-type": "application/octet-stream" },
      payload: ONE_PIXEL_PNG,
    });
    expect(res.statusCode).toBe(400);
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
    expect(body.dump.fileName).toMatch(/^acpio-dump-.*\.json$/);
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
      availability: { cursor: false, omp: false, builtin: false },
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

/** Poll GET /api/sessions/:id until `check` passes. The warm-up/agent side is
 *  a real child process, so fake timers cannot advance it. */
async function waitForDetail(
  sessionId: string,
  check: (detail: SessionDetailDto) => boolean,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "no detail fetched";
  while (Date.now() < deadline) {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    if (res.statusCode === 200) {
      const detail = res.json() as SessionDetailDto;
      if (check(detail)) return detail;
      lastSeen = `status=${detail.status} parts=${detail.messages
        .flatMap((m) => m.parts)
        .map(
          (p) =>
            `${p.type}:${p.payload.pending ? "pending" : "settled"}${
              typeof p.payload.text === "string" ? `(${p.payload.text.slice(0, 120)})` : ""
            }`,
        )
        .join(",")}`;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`condition not met within ${timeoutMs}ms (${lastSeen})`);
}

function questionPart(detail: SessionDetailDto): MessagePartDto | undefined {
  for (const message of detail.messages) {
    const part = message.parts.find((p) => p.type === "question");
    if (part) return part;
  }
  return undefined;
}

function textParts(detail: SessionDetailDto): string[] {
  return detail.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload.text ?? ""));
}

describe("folder MCP files reach the agent", () => {
  it("passes a folder's own MCP file server to the chat's agent session", async () => {
    const cwd = await newTempDir("acpio-mcp-session-");
    await fsp.mkdir(path.join(cwd, ".omp"), { recursive: true });
    await fsp.writeFile(
      path.join(cwd, ".omp", "mcp.json"),
      '{"mcpServers":{"folder-fs":{"command":"C:/Tools/mcp.exe","args":["--stdio"]}}}',
      "utf8",
    );
    await connectAgent();
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "MCP-LIST" },
    });
    const detail = await waitForDetail(session.id, (d) =>
      textParts(d).some((text) => text.startsWith("mcp=")),
    );
    expect(textParts(detail).find((text) => text.startsWith("mcp="))).toBe("mcp=folder-fs");
  });

  it("attaches a globally disabled server the chat's folder switched on", async () => {
    const cwd = await newTempDir("acpio-mcp-folder-on-");
    const key = cwd.replace(/\\/g, "/");
    await connectAgent();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        mcpServers: [
          { id: "off", name: "folder-on", enabled: false, type: "stdio", command: "C:/Tools/mcp.exe" },
          { id: "on", name: "folder-off", enabled: true, type: "stdio", command: "C:/Tools/mcp2.exe" },
        ],
        mcpFolderConfigs: {
          [key]: { overrides: { off: true, on: false }, servers: [] },
        },
      },
    });

    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: { cwd } });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "MCP-LIST" },
    });
    const detail = await waitForDetail(session.id, (d) =>
      textParts(d).some((text) => text.startsWith("mcp=")),
    );
    // The folder's switch decides, in both directions: the globally off server
    // attaches, the globally on one does not.
    expect(textParts(detail).find((text) => text.startsWith("mcp="))).toBe("mcp=folder-on");
  });
});

describe("folder MCP settings reach live board tasks", () => {
  it("picks up a folder's MCP config in a running board-task agent", async () => {
    const cwd = await newTempDir("acpio-mcp-board-");
    const key = cwd.replace(/\\/g, "/");
    await connectAgent();
    const board = (
      await app.inject({ method: "POST", url: "/api/boards", payload: { name: "MCP board" } })
    ).json() as { id: string };
    const folders = await app.inject({
      method: "PUT",
      url: `/api/boards/${board.id}/folders`,
      payload: { cwds: [cwd] },
    });
    expect(folders.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { cwd, boardId: board.id },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json() as { id: string };
    runtimeSessionIds.push(session.id);

    // The first turn boots the board task's agent — no folder server yet.
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "MCP-LIST" },
    });
    const before = await waitForDetail(session.id, (d) =>
      textParts(d).some((text) => text.startsWith("mcp=")),
    );
    expect(textParts(before).find((text) => text.startsWith("mcp="))).toBe("mcp=");

    // The folder gains a server while that agent is alive: the settings route
    // fires the restart sweep, which must reach board tasks too.
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        mcpFolderConfigs: {
          [key]: {
            overrides: {},
            servers: [
              {
                id: "own",
                name: "folder-own",
                enabled: true,
                type: "stdio",
                command: "C:/Tools/mcp.exe",
              },
            ],
          },
        },
      },
    });
    expect(put.statusCode).toBe(200);

    // The sweep is fire-and-forget (a mid-turn change restarts on idle), so
    // keep asking until the restarted agent answers with the new list — a
    // board-task agent the sweep skips never does.
    const deadline = Date.now() + 10_000;
    let pickedUp = false;
    while (!pickedUp && Date.now() < deadline) {
      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "MCP-LIST" },
      });
      try {
        await waitForDetail(
          session.id,
          (d) => textParts(d).some((text) => text === "mcp=folder-own"),
          3_000,
        );
        pickedUp = true;
      } catch {
        // restart still pending — ask again
      }
    }
    expect(pickedUp).toBe(true);
  });
});

describe("durable questions", () => {
  /** Inline-question UI answer shape (elicitation accept with one option). */
  const PICK_GREEN = {
    outcome: {
      outcome: "accepted",
      answers: [{ questionId: "answer", selectedOptionIds: ["green"] }],
    },
  };

  it("answers a live elicitation and feeds it back to the agent", async () => {
    await connectAgent();
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "ELICIT: pick a colour" },
    });
    const parked = await waitForDetail(
      session.id,
      (d) => d.status === "waiting" && Boolean(questionPart(d)?.payload.pending),
    );
    const question = questionPart(parked)!;
    const requestId = String(question.payload.requestId ?? "");
    expect(requestId).toBeTruthy();
    expect(question.payload.questions).toHaveLength(1);

    const answer = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers/${encodeURIComponent(requestId)}`,
      payload: { result: PICK_GREEN },
    });
    expect(answer.statusCode).toBe(200);

    // The fake agent echoes what the client replied → proof the answer reached it.
    // (Only the echo is awaited: after a live elicitation answer the host holds a
    // deliberate multi-second grace for post-answer agent work before settling.)
    const done = await waitForDetail(
      session.id,
      (d) => textParts(d).some((t) => t.includes('"answer":"green"')),
    );
    expect(questionPart(done)?.payload.pending).toBe(false);
    expect(questionPart(done)?.payload.answerSummary).toBe("green");
    setAgentAvailable("omp", false);
  });

  it("keeps a question answerable after a restart and resumes the turn when answered", async () => {
    await connectAgent();
    const session = await seedSession({ title: "Parked on a question" });
    runtimeSessionIds.push(session.id);
    const assistant = await createMessage(session.id, "assistant");
    const requestId = `${session.id}:q-restart`;
    await appendPart(session.id, assistant.id, "question", {
      requestId,
      pending: true,
      title: "Pick a colour",
      questions: [
        { id: "answer", prompt: "Pick one", options: [{ id: "green", label: "green" }] },
      ],
    });
    await db
      .update(sessionsTable)
      .set({ status: "waiting" })
      .where(eq(sessionsTable.id, session.id));

    // Boot sweep after a restart: no runtime survives, but a session parked on a
    // question is not a stale turn — the question is the answerable state.
    const recovered = await reconcileStaleSessions();
    expect(recovered.sessions).toBe(0);

    // Opening the chat in the UI warms a fresh ACP process (GET /api/sessions/:id
    // fires warmAcp). That warm-up must not report the chat as idle while the
    // question is unanswered — otherwise the composer unlocks and the question
    // stops being the pending one.
    const parked = await waitForDetail(
      session.id,
      (d) => d.acpSessionId?.startsWith("fake-sess-") && questionPart(d)?.payload.pending === true,
    );
    expect(parked.status).toBe("waiting");

    // Answering later (days, several restarts) resumes the turn on a fresh agent.
    const answer = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers/${encodeURIComponent(requestId)}`,
      payload: { result: PICK_GREEN },
    });
    expect(answer.statusCode).toBe(200);

    const done = await waitForDetail(
      session.id,
      (d) => d.status === "idle" && textParts(d).some((t) => t.includes("green")),
    );
    expect(questionPart(done)?.payload.pending).toBe(false);
    expect(questionPart(done)?.payload.answerSummary).toBe("green");
    // The resumed turn carries the question and the answer back to the agent.
    const resumedText = textParts(done).join("\n");
    expect(resumedText).toContain("Pick a colour");
    expect(resumedText).toContain("green");
    setAgentAvailable("omp", false);
  });

  it("keeps a question answerable after the harness dies while parked on it", async () => {
    await connectAgent();
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "ELICIT-DIE: pick a colour" },
    });
    const parked = await waitForDetail(
      session.id,
      (d) => d.status === "waiting" && Boolean(questionPart(d)?.payload.pending),
    );
    const requestId = String(questionPart(parked)?.payload.requestId ?? "");
    // The fake agent exits 150ms after asking and nothing in the public API
    // exposes that child's death — wait past the window before answering.
    await new Promise((r) => setTimeout(r, 500));

    const afterDeath = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json() as SessionDetailDto;
    expect(afterDeath.status).toBe("waiting");
    expect(questionPart(afterDeath)?.payload.pending).toBe(true);

    const answer = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers/${encodeURIComponent(requestId)}`,
      payload: { result: PICK_GREEN },
    });
    expect(answer.statusCode).toBe(200);

    const done = await waitForDetail(
      session.id,
      (d) => d.status === "idle" && textParts(d).some((t) => t.includes("green")),
    );
    expect(questionPart(done)?.payload.pending).toBe(false);
    expect(questionPart(done)?.payload.answerSummary).toBe("green");
    setAgentAvailable("omp", false);
  });

  it("Stop settles the parked question instead of leaving it answerable", async () => {
    await connectAgent();
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "ELICIT: pick a colour" },
    });
    await waitForDetail(
      session.id,
      (d) => d.status === "waiting" && Boolean(questionPart(d)?.payload.pending),
    );

    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/cancel` });

    const stopped = await waitForDetail(
      session.id,
      (d) => d.status === "idle" && questionPart(d)?.payload.pending === false,
    );
    expect(questionPart(stopped)?.payload.answerSummary).toBe("—");
    // A cancelled question must not park the chat across a restart either.
    const recovered = await reconcileStaleSessions();
    expect(recovered.sessions).toBe(0);
    setAgentAvailable("omp", false);
  });

  it("rejects an answer to a question that was already answered", async () => {
    const session = await seedSession({ title: "Answered" });
    const assistant = await createMessage(session.id, "assistant");
    await appendPart(session.id, assistant.id, "question", {
      requestId: `${session.id}:q-old`,
      pending: false,
      title: "Pick a colour",
      answerSummary: "green",
      questions: [{ id: "answer", prompt: "Pick one", options: [] }],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers/${encodeURIComponent(`${session.id}:q-old`)}`,
      payload: { result: PICK_GREEN },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Question request not found");
  });
});

describe("session_busy and autonomous turns", () => {
  it("waits out an agent turn it didn't prompt and delivers the message instead of erroring", async () => {
    await connectAgent();
    process.env.FAKE_PROMPT_BUSY_ONCE = "1";
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
      expect(created.statusCode).toBe(200);
      const session = created.json();
      runtimeSessionIds.push(session.id);
      await waitForAcpSessionId(session.id);

      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "busy once" },
      });
      // The first session/prompt answers session_busy; the turn must retry and
      // land the answer rather than surface the raw agent error as chat state.
      await waitForDetail(
        session.id,
        (d) =>
          d.status === "idle" && textParts(d).some((t) => t.includes("echo: busy once")),
      );
    } finally {
      delete process.env.FAKE_PROMPT_BUSY_ONCE;
    }
  });

  it("adopts a turn the agent started itself and queues the next user prompt behind it", async () => {
    await connectAgent();
    process.env.FAKE_AUTONOMOUS = "1";
    try {
      const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
      expect(created.statusCode).toBe(200);
      const session = created.json();
      runtimeSessionIds.push(session.id);
      await waitForAcpSessionId(session.id);

      // The host never prompted this turn — without adoption its chunks were
      // dropped and the chat sat idle-looking while the agent worked.
      await waitForDetail(session.id, (d) =>
        textParts(d).some((t) => t.includes("autonomous start")),
      );
      const turn = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/turn` });
      expect(turn.statusCode).toBe(200);
      expect(turn.json().running).toBe(true);

      await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "queued behind autonomous" },
      });
      await waitForDetail(session.id, (d) => {
        const texts = textParts(d);
        return (
          d.status === "idle" &&
          texts.some((t) => t.includes("autonomous done")) &&
          texts.some((t) => t.includes("echo: queued behind autonomous"))
        );
      });
    } finally {
      delete process.env.FAKE_AUTONOMOUS;
    }
  });
});

describe("disabled providers", () => {
  it("flags a switched-off harness in /api/adapters and drops it from agent status", async () => {
    await connectAgent();
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { disabledProviders: ["omp"] },
    });
    expect(put.statusCode).toBe(200);
    // A switched-off harness is neither the default nor the connected agent.
    expect(put.json().disabledProviders).toEqual(["omp"]);
    expect(put.json().defaultProvider).toBe("cursor");
    expect(put.json().connectedProvider).toBeNull();

    const adapters = (await app.inject({ method: "GET", url: "/api/adapters" })).json() as Array<{
      id: string;
      enabled: boolean;
    }>;
    expect(adapters.map((a) => [a.id, a.enabled])).toEqual([
      ["cursor", true],
      ["omp", false],
      ["builtin", true],
    ]);

    const status = (await app.inject({ method: "GET", url: "/api/agent/status" })).json();
    expect(status).toEqual({
      provider: null,
      available: false,
      availability: { cursor: false, builtin: false },
    });
  });

  it("turning the harness back on restores its registry row", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { disabledProviders: ["cursor", "omp"] },
    });
    const off = (await app.inject({ method: "GET", url: "/api/adapters" })).json() as Array<{
      enabled: boolean;
    }>;
    expect(off.map((a) => a.enabled)).toEqual([false, false, true]);

    await app.inject({ method: "PUT", url: "/api/settings", payload: { disabledProviders: [] } });
    const on = (await app.inject({ method: "GET", url: "/api/adapters" })).json() as Array<{
      enabled: boolean;
    }>;
    expect(on.map((a) => a.enabled)).toEqual([true, true, true]);
  });

  it("refuses a new session for a switched-off harness", async () => {
    await connectAgent();
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { disabledProviders: ["omp"] },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { provider: "omp" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses to drive an existing chat whose harness was switched off", async () => {
    await connectAgent();
    const created = await app.inject({ method: "POST", url: "/api/sessions", payload: {} });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    runtimeSessionIds.push(session.id);
    await waitForAcpSessionId(session.id);

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { disabledProviders: ["omp"] },
    });
    // Availability still reports the harness from before the switch, so only
    // the disabled list can keep the chat from being driven again.
    setAgentAvailable("omp", true);
    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/prompt`,
      payload: { text: "must not reach the harness" },
    });
    expect(prompt.statusCode).toBe(400);
    expect(prompt.json().error).toBe("This chat's agent is not running on this PC");

    const detail = (
      await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })
    ).json();
    expect(detail.messages.some((m: { role: string }) => m.role === "user")).toBe(false);
  });
});

describe("user-defined agents", () => {
  /** Point a custom agent at the fake ACP agent so it can really connect. */
  const fakeSpec = {
    id: "fake-acp",
    label: "Fake ACP",
    command: process.execPath,
    args: [FAKE_AGENT],
  };

  it("registers a custom agent from settings and heals reserved ids", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        customAgents: [fakeSpec, { id: "omp", label: "Shadow", command: "shadow.exe" }],
      },
    });
    expect(put.statusCode).toBe(200);
    // The reserved id is dropped, the agent is normalized (defaults filled in).
    expect(put.json().customAgents).toEqual([
      {
        ...fakeSpec,
        restoreMode: "resume",
        suppressReplayOnLoad: false,
        parameterizedModelPicker: true,
        subagentStreaming: false,
        cloudCatalog: false,
      },
    ]);

    const meta = (await app.inject({ method: "GET", url: "/api/adapters" })).json() as Array<{
      id: string;
      label: string;
      custom?: boolean;
      commandField: string;
      defaultCommand: string;
    }>;
    expect(meta.map((a) => a.id)).toEqual(["cursor", "omp", "builtin", "fake-acp"]);
    expect(meta[3]).toMatchObject({
      custom: true,
      label: "Fake ACP",
      commandField: "",
      defaultCommand: process.execPath,
    });
  });

  it("runs a custom agent end to end (spawn + initialize + session/new)", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { customAgents: [fakeSpec] },
    });
    setAgentAvailable("fake-acp", true);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { provider: "fake-acp" },
    });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    runtimeSessionIds.push(session.id);
    expect(session.provider).toBe("fake-acp");
    const detail = await waitForAcpSessionId(session.id);
    expect(detail.acpSessionId).toBeTruthy();

    // A provider that is not in the registry is refused explicitly.
    const bogus = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { provider: "not-registered" },
    });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().error).toBe("unknownAgent");
  });

  it("drops the agent from the registry when it is removed from settings", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { customAgents: [fakeSpec] },
    });
    await app.inject({ method: "PUT", url: "/api/settings", payload: { customAgents: [] } });
    const meta = (await app.inject({ method: "GET", url: "/api/adapters" })).json() as Array<{
      id: string;
    }>;
    expect(meta.map((a) => a.id)).toEqual(["cursor", "omp", "builtin"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { provider: "fake-acp" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknownAgent");
  });
});

// Placed after every availability assertion in this file: the online probe
// leaves `builtin` marked available and earlier tests pin it to false.
describe("built-in agent probe", () => {
  it("reports offline without an endpoint and online once one is configured", async () => {
    const off = await app.inject({
      method: "POST",
      url: "/api/agent/probe",
      payload: { provider: "builtin" },
    });
    expect(off.json()).toMatchObject({ ok: false, provider: "builtin" });
    expect(String(off.json().message)).toMatch(/endpoint/i);
    const status = (await app.inject({ method: "GET", url: "/api/agent/status" })).json();
    expect(status.availability.builtin).toBe(false);

    // Booting the in-process agent is all the probe needs — no endpoint call,
    // so an unreachable URL must not make this assertion flaky.
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        builtinProviders: [
          { id: "p1", name: "Local", url: "http://127.0.0.1:1/v1", apiKey: "", models: [] },
        ],
      },
    });
    const on = await app.inject({
      method: "POST",
      url: "/api/agent/probe",
      payload: { provider: "builtin" },
    });
    expect(on.json()).toMatchObject({ ok: true, provider: "builtin" });
    const status2 = (await app.inject({ method: "GET", url: "/api/agent/status" })).json();
    expect(status2.availability.builtin).toBe(true);
  });
});

describe("built-in model catalog", () => {
  it("fetches /models from the form's URL and explains a missing endpoint", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/agent/builtin/models",
      payload: {},
    });
    expect(missing.json()).toMatchObject({ ok: false, models: [] });
    expect(String(missing.json().error)).toMatch(/endpoint/i);

    const seenHeaders: Record<string, string> = {};
    const endpoint = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/registry.json") {
        res.end(
          JSON.stringify({
            "test-vendor": {
              api: `${base}/v1`,
              models: { m1: { limit: { context: 200_000 } } },
            },
          }),
        );
        return;
      }
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") seenHeaders[name] = value;
      }
      res.end(
        JSON.stringify({
          data: [
            { id: "m1", name: "Model One" },
            { id: "m2", context_length: 64_000 },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const addr = endpoint.address();
    if (!addr || typeof addr === "string") {
      throw new Error("catalog endpoint did not bind a TCP port");
    }
    const base = `http://127.0.0.1:${addr.port}`;
    const savedRegistry = process.env.ACP_MODELS_REGISTRY_URL;
    process.env.ACP_MODELS_REGISTRY_URL = `${base}/registry.json`;
    try {
      // The unsaved URL from the form is enough — no settings write needed.
      // m1 has no window of its own, so the registry fills it in; the window
      // the endpoint reports for m2 is left alone.
      const ok = await app.inject({
        method: "POST",
        url: "/api/agent/builtin/models",
        payload: {
          url: `${base}/v1`,
          headers: [
            { name: "x-opencode-session", value: "{{sessionId}}" },
            { name: "x-trace", value: "on" },
          ],
        },
      });
      expect(ok.json()).toEqual({
        ok: true,
        models: [
          { id: "m1", label: "Model One", contextWindow: 200_000 },
          { id: "m2", contextWindow: 64_000 },
        ],
      });
      // Extra headers reach the endpoint; the session placeholder has nothing
      // to resolve against during a probe, so its row is not sent half-baked.
      expect(seenHeaders["x-trace"]).toBe("on");
      expect(seenHeaders["x-opencode-session"]).toBeUndefined();
    } finally {
      if (savedRegistry === undefined) delete process.env.ACP_MODELS_REGISTRY_URL;
      else process.env.ACP_MODELS_REGISTRY_URL = savedRegistry;
      clearModelRegistryCache();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    }
  });
});

describe("built-in agent image attachments", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  /** OpenAI-compatible stub: streams one sentence, records user message contents. */
  async function startModelStub(): Promise<{
    url: string;
    userContents: unknown[];
    /** Resolves with the first user message content the model receives. */
    firstUserContent: Promise<unknown>;
    close(): Promise<void>;
  }> {
    const userContents: unknown[] = [];
    const first = Promise.withResolvers<unknown>();
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        const rawMessages =
          parsed && typeof parsed === "object" && "messages" in parsed ? parsed.messages : undefined;
        const messages = Array.isArray(rawMessages) ? rawMessages : [];
        const user = messages.find((m) => m?.role === "user");
        if (user) {
          userContents.push(user.content);
          first.resolve(user.content);
        }
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
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
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    return {
      url: `http://127.0.0.1:${address.port}/v1`,
      userContents,
      firstUserContent: first.promise,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.close(closed.resolve);
        return closed.promise;
      },
    };
  }

  it("delivers an uploaded screenshot to the model as image content", async () => {
    const stub = await startModelStub();
    const cwd = await newTempDir("acpio-image-");
    const shot = path.join(cwd, ".acpio-attachments", "shot.png");
    await fsp.mkdir(path.dirname(shot), { recursive: true });
    await fsp.writeFile(shot, PNG);
    setAgentAvailable("builtin", true);
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        connectedProvider: "builtin",
        defaultProvider: "builtin",
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
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { provider: "builtin", cwd },
      });
      expect(created.statusCode).toBe(200);
      const session = created.json() as { id: string };
      runtimeSessionIds.push(session.id);

      const sent = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: {
          text: "что на скриншоте?",
          attachments: [{ name: "shot.png", path: shot }],
        },
      });
      expect(sent.statusCode).toBe(200);

      // The prompt route is fire-and-forget: the stub resolves when the model
      // call actually arrives, so nothing here guesses at a duration.
      expect(await stub.firstUserContent).toEqual([
        { type: "text", text: expect.stringContaining("что на скриншоте?") },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
      ]);
      // Let the turn finish before the test disposes the runtime: a real timer
      // is the only probe here, because the route exposes no promise for it.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const turn = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/turn` })).json() as {
          running?: boolean;
        };
        if (!turn.running) break;
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 25);
        await tick.promise;
      }
    } finally {
      await stub.close();
    }
  }, 15_000);
});

describe("built-in agent MCP tools", () => {
  const FIXTURE = path.join(REPO_ROOT, "packages/adapter-builtin/src/fixtures/mcpStdioFixture.mjs");

  /**
   * OpenAI-compatible stub that asks for `mcp__probe_echo` on the first call and
   * answers in prose once it sees the tool result — i.e. it drives the whole
   * session/new → tools/list → tools/call path without a real model.
   */
  async function startToolStub() {
    const bodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
    const called = Promise.withResolvers<void>();
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        bodies.push(parsed);
        const afterTool = (parsed.messages ?? []).some((m) => m.role === "tool");
        if (afterTool) called.resolve();
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const frame = (delta: Record<string, unknown>, finish: string | null) =>
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
        if (afterTool) {
          res.write(frame({ role: "assistant", content: "готово" }, null));
          res.write(frame({}, "stop"));
        } else {
          res.write(
            frame(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "mcp__probe_echo", arguments: JSON.stringify({ text: "hi" }) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(frame({}, "tool_calls"));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    return {
      url: `http://127.0.0.1:${address.port}/v1`,
      bodies,
      called: called.promise,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.close(closed.resolve);
        return closed.promise;
      },
    };
  }

  it("connects the session's MCP server, lists its tools and runs one end to end", async () => {
    const stub = await startToolStub();
    const cwd = await newTempDir("acpio-mcp-");
    setAgentAvailable("builtin", true);
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        connectedProvider: "builtin",
        defaultProvider: "builtin",
        builtinProviders: [
          {
            id: "p1",
            name: "Local",
            url: stub.url,
            apiKey: "",
            models: [{ id: "m1", label: "M1", contextWindow: 8_000 }],
          },
        ],
        mcpServers: [
          {
            id: "probe",
            name: "probe",
            enabled: true,
            type: "stdio",
            command: process.execPath,
            args: [FIXTURE],
          },
        ],
      },
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { provider: "builtin", cwd },
      });
      expect(created.statusCode).toBe(200);
      const session = created.json() as { id: string };
      runtimeSessionIds.push(session.id);

      const sent = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "echo hi through the mcp tool" },
      });
      expect(sent.statusCode).toBe(200);

      // The stub's second request is the proof: it carries the assistant's tool
      // call and the `<hi>` the fixture server produced for it.
      await stub.called;
      const second = JSON.stringify(stub.bodies[1]);
      expect(second).toContain("mcp__probe_echo");
      expect(second).toContain("<hi>");

      // Let the turn end before the test disposes the runtime, so the close is
      // not reported as a failed prompt.
      await waitForTurnEnd(session.id);
    } finally {
      await stub.close();
    }
  }, 20_000);
});

describe("built-in agent workspace search", () => {
  /**
   * Drives one tool per model step: the stub answers `calls[n]` while n tool
   * results are in the request, then finishes. This is what proves `glob` and
   * `grep` are really served by the harness, not just by the unit mocks.
   */
  async function startSequenceStub(calls: Array<{ name: string; args: Record<string, unknown> }>) {
    const bodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
    const finished = Promise.withResolvers<void>();
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        bodies.push(parsed);
        const toolResults = (parsed.messages ?? []).filter((m) => m.role === "tool").length;
        res.setHeader("content-type", "text/event-stream");
        const chunk = (payload: Record<string, unknown>) => `data: ${JSON.stringify(payload)}\n\n`;
        const frame = (delta: Record<string, unknown>, finish: string | null) =>
          chunk({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
        const next = calls[toolResults];
        if (next) {
          res.write(
            frame(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${toolResults}`,
                    type: "function",
                    function: { name: next.name, arguments: JSON.stringify(next.args) },
                  },
                ],
              },
              null,
            ),
          );
          res.write(frame({}, "tool_calls"));
        } else {
          res.write(frame({ role: "assistant", content: "готово" }, null));
          res.write(frame({}, "stop"));
          finished.resolve();
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind a port");
    return {
      url: `http://127.0.0.1:${address.port}/v1`,
      bodies,
      finished: finished.promise,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.close(closed.resolve);
        return closed.promise;
      },
    };
  }

  it("serves glob and grep to the agent over the session", async () => {
    const stub = await startSequenceStub([
      { name: "glob", args: { pattern: "**/*.ts" } },
      { name: "grep", args: { pattern: "calcTotal" } },
    ]);
    const cwd = await newTempDir("acpio-fsagent-");
    await fsp.mkdir(path.join(cwd, "src"), { recursive: true });
    await fsp.writeFile(path.join(cwd, "src", "a.ts"), "export const calcTotal = 1;\n");
    await fsp.writeFile(path.join(cwd, "notes.md"), "nothing here\n");
    setAgentAvailable("builtin", true);
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        connectedProvider: "builtin",
        defaultProvider: "builtin",
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
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { provider: "builtin", cwd },
      });
      expect(created.statusCode).toBe(200);
      const session = created.json() as { id: string };
      runtimeSessionIds.push(session.id);

      const sent = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/prompt`,
        payload: { text: "find calcTotal" },
      });
      expect(sent.statusCode).toBe(200);

      // Last request = both tool results in context: the glob hit and the grep
      // line the harness produced for them.
      await stub.finished;
      const last = JSON.stringify(stub.bodies[stub.bodies.length - 1]);
      expect(last).toContain("src/a.ts");
      expect(last).toContain("1: export const calcTotal = 1;");
      expect(last).not.toContain("notes.md");
      await waitForTurnEnd(session.id);
    } finally {
      await stub.close();
    }
  }, 20_000);
});

describe("git routes", () => {
  function git(cwd: string, args: string[]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout;
  }

  /** Temp repo with one commit and the identity git needs in order to commit. */
  async function gitRepo() {
    const dir = await newTempDir("acpio-gitroutes-");
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "t@t"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    await fsp.writeFile(path.join(dir, "tracked.txt"), "base\n");
    git(dir, ["add", "tracked.txt"]);
    git(dir, ["commit", "-m", "init"]);
    return dir;
  }

  it("serves status, diff, log, show, commit detail and blame for a worktree", async () => {
    const dir = await gitRepo();
    await fsp.writeFile(path.join(dir, "tracked.txt"), "base\nchanged\n");
    const session = await seedSession({ cwd: dir });
    const url = (suffix: string) => `/api/sessions/${session.id}${suffix}`;

    const status = await app.inject({ method: "GET", url: url("/git/status") });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as GitStatusDto;
    expect(statusBody.repo).toBe(true);
    expect(statusBody.files.map((file) => file.path)).toEqual(["tracked.txt"]);
    expect(statusBody.additions).toBe(1);

    const diff = await app.inject({ method: "GET", url: url("/git/diff?path=tracked.txt") });
    expect((diff.json() as { diff: string }).diff).toContain("+changed");

    const log = await app.inject({ method: "GET", url: url("/git/log") });
    expect((log.json() as { commits: GitCommitDto[] }).commits.map((commit) => commit.subject)).toEqual([
      "init",
    ]);

    const show = await app.inject({ method: "GET", url: url("/git/show?rev=HEAD&path=tracked.txt") });
    expect((show.json() as { diff: string }).diff).toContain("+base");

    const detail = await app.inject({ method: "GET", url: url("/git/commit?rev=HEAD") });
    const detailBody = detail.json() as { detail: GitCommitDetailDto };
    expect(detailBody.detail.subject).toBe("init");
    expect(detailBody.detail.files.map((file) => file.path)).toEqual(["tracked.txt"]);

    const blame = await app.inject({ method: "GET", url: url("/git/blame?path=tracked.txt") });
    expect((blame.json() as { blame: string }).blame).toContain("base");
  });

  it("returns the refreshed status from a mutation", async () => {
    const dir = await gitRepo();
    await fsp.writeFile(path.join(dir, "new.txt"), "hello\n");
    const session = await seedSession({ cwd: dir });
    const url = (suffix: string) => `/api/sessions/${session.id}${suffix}`;

    const staged = await app.inject({
      method: "POST",
      url: url("/git/stage"),
      payload: { paths: ["new.txt"], staged: true },
    });
    expect(staged.statusCode).toBe(200);
    const stagedBody = staged.json() as { ok: boolean; status: GitStatusDto };
    expect(stagedBody.status.files.map((file) => [file.path, file.index, file.worktree])).toEqual([
      ["new.txt", "A", " "],
    ]);

    const committed = await app.inject({
      method: "POST",
      url: url("/git/commit"),
      payload: { message: "add new" },
    });
    expect(committed.statusCode).toBe(200);
    const committedBody = committed.json() as { ok: boolean; status: GitStatusDto };
    expect(committedBody.status).toMatchObject({ repo: true, files: [] });
    expect(git(dir, ["log", "-1", "--pretty=%s"]).trim()).toBe("add new");
  });

  it("reports an empty status outside a repository", async () => {
    const dir = await newTempDir("acpio-gitroutes-plain-");
    const session = await seedSession({ cwd: dir });

    const res = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/git/status` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repo: false, root: "", files: [] });
  });

  it("deletes a local branch, asking again before it drops unmerged commits", async () => {
    const dir = await gitRepo();
    const base = git(dir, ["branch", "--show-current"]).trim();
    const session = await seedSession({ cwd: dir });
    const url = `/api/sessions/${session.id}/git/delete-branch`;

    // A branch at HEAD is reachable from HEAD, so git drops it without force.
    git(dir, ["branch", "merged-branch"]);
    const merged = await app.inject({ method: "POST", url, payload: { branch: "merged-branch" } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ ok: true, unmerged: false });
    expect(git(dir, ["branch", "--list"]).trim()).toBe(`* ${base}`);

    // A branch with its own commit is not: the refusal is the question.
    git(dir, ["checkout", "-b", "unmerged-branch"]);
    await fsp.writeFile(path.join(dir, "own.txt"), "own\n");
    git(dir, ["add", "own.txt"]);
    git(dir, ["commit", "-m", "own work"]);
    git(dir, ["checkout", base]);

    const refused = await app.inject({ method: "POST", url, payload: { branch: "unmerged-branch" } });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ ok: false, unmerged: true });
    expect(git(dir, ["branch", "--list", "unmerged-branch"]).trim()).toBe("unmerged-branch");

    const forced = await app.inject({
      method: "POST",
      url,
      payload: { branch: "unmerged-branch", force: true },
    });
    expect(forced.statusCode).toBe(200);
    const forcedBody = forced.json() as { ok: boolean; unmerged: boolean; status: GitStatusDto };
    expect(forcedBody).toMatchObject({ ok: true, unmerged: false });
    expect(forcedBody.status.branches).toEqual([base]);
  });

  it("refuses to delete the checked out branch", async () => {
    const dir = await gitRepo();
    const session = await seedSession({ cwd: dir });

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/git/delete-branch`,
      payload: { branch: git(dir, ["branch", "--show-current"]).trim() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("checked out");
  });

  it("refuses the main branch even from another branch, and says so in the status", async () => {
    const dir = await gitRepo();
    // Merged into HEAD, so git itself would drop any of these without complaint.
    git(dir, ["branch", "main"]);
    git(dir, ["branch", "keep"]);
    git(dir, ["branch", "gone"]);
    git(dir, ["checkout", "keep"]);
    const session = await seedSession({ cwd: dir });
    const url = (suffix: string) => `/api/sessions/${session.id}${suffix}`;

    const status = await app.inject({ method: "GET", url: url("/git/status") });
    expect((status.json() as GitStatusDto).protectedBranches).toEqual(
      expect.arrayContaining(["keep", "main"]),
    );
    // The composer poll asks for the summary; it must carry the same protection,
    // or the menu would offer a delete for main until the full status lands.
    const summary = await app.inject({ method: "GET", url: url("/git/status?summary=1") });
    expect((summary.json() as GitStatusDto).protectedBranches).toEqual(
      expect.arrayContaining(["keep", "main"]),
    );

    const gone = await app.inject({ method: "POST", url: url("/git/delete-branch"), payload: { branch: "gone" } });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ ok: true });

    const main = await app.inject({ method: "POST", url: url("/git/delete-branch"), payload: { branch: "main" } });
    expect(main.statusCode).toBe(400);
    expect(main.json().error).toContain("main branch");
    expect(git(dir, ["branch", "--list", "main"]).trim()).toBe("main");
  });
});
