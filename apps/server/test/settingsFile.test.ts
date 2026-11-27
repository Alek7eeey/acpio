// A setting is only done when a settings file carries it: Export writes the
// stored object, Import keeps what `SETTING_KEYS` recognises, and both are
// silent about a key that is missing from either side. This walks the file the
// way a user does — set the value, export, import it elsewhere.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp, useResetDb } from "./test-utils.js";
import { db } from "../src/db/client.js";
import { settings as settingsTable } from "../src/db/schema.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});
useResetDb();

const put = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/settings", payload });

describe("settings file: the context drift warning", () => {
  it("travels with the file the way any other switch does", async () => {
    expect((await put({ diagnosticsContextDrift: true })).statusCode).toBe(200);
    const exported = await app.inject({ method: "GET", url: "/api/settings/export" });
    expect(exported.json().settings.diagnosticsContextDrift).toBe(true);

    const imported = await app.inject({
      method: "POST",
      url: "/api/settings/import",
      payload: { settings: { diagnosticsContextDrift: false } },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().applied).toContain("diagnosticsContextDrift");
    expect(imported.json().settings.diagnosticsContextDrift).toBe(false);
  });
});

describe("settings file: the attachments folder", () => {
  it("travels with the file and leaves the project folder as the default", async () => {
    const fresh = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fresh.json().attachmentsDir).toBe("");

    expect((await put({ attachmentsDir: "docs/attachments" })).statusCode).toBe(200);
    const exported = await app.inject({ method: "GET", url: "/api/settings/export" });
    expect(exported.json().settings.attachmentsDir).toBe("docs/attachments");

    const imported = await app.inject({
      method: "POST",
      url: "/api/settings/import",
      payload: { settings: { attachmentsDir: "E:/shots" } },
    });
    expect(imported.json().applied).toContain("attachmentsDir");
    expect(imported.json().settings.attachmentsDir).toBe("E:/shots");
  });

  // The second variant of the import dialog: a file on the server's disk, which
  // a phone's own file picker cannot reach.
  it("imports the file at a path the app's browser picked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acpio-settings-"));
    try {
      const file = path.join(dir, "acpio-settings.json");
      await writeFile(
        file,
        JSON.stringify({ settings: { attachmentsDir: "E:/from-disk", cursorApiKey: "sk-x" } }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/api/settings/import",
        payload: { path: file },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toContain("attachmentsDir");
      expect(res.json().settings.attachmentsDir).toBe("E:/from-disk");
      // The file's credential is still not a setting.
      expect(res.json().settings.cursorApiKey).not.toBe("sk-x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("settings file: where the editor's arrows sit", () => {
  it("exports the placement the user chose", async () => {
    expect((await put({ editorNavPlacement: "statusBar" })).statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/api/settings/export" });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.editorNavPlacement).toBe("statusBar");
  });

  it("refuses a placement the app does not know", async () => {
    const res = await put({ editorNavPlacement: "everywhere" });
    expect(res.statusCode).toBe(400);
  });

  it("applies an imported placement and names it", async () => {
    await put({ editorNavPlacement: "statusBar" });

    const res = await app.inject({
      method: "POST",
      url: "/api/settings/import",
      payload: { settings: { editorNavPlacement: "tabs", cursorApiKey: "sk-from-file" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toContain("editorNavPlacement");
    expect(res.json().settings.editorNavPlacement).toBe("tabs");
    // A credential in the file is not a setting: the local wallet stays.
    expect(res.json().settings.cursorApiKey).not.toBe("sk-from-file");
  });

  it("carries the default until the user moves the arrows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/export" });
    expect(res.json().settings.editorNavPlacement).toBe("tabs");
  });
});

describe("settings: a harness's own environment", () => {
  // The two provider keys every harness used to inherit are each CLI's own env
  // now — a stored install keeps them, on every shipped CLI, where the row for
  // that CLI shows them.
  it("moves the shared provider keys onto the shipped CLIs", async () => {
    db.run(sql`DELETE FROM settings`);
    await db.insert(settingsTable).values({
      key: "app",
      value: { settingsSchema: 11, anthropicApiKey: "sk-ant-1", openaiApiKey: "sk-oa" },
    });

    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.anthropicApiKey).toBeUndefined();
    expect(body.openaiApiKey).toBeUndefined();
    for (const id of ["cursor", "omp", "opencode"]) {
      expect(body.adapterEnv[id]).toEqual({
        ANTHROPIC_API_KEY: "sk-ant-1",
        OPENAI_API_KEY: "sk-oa",
      });
    }
  });

  it("keeps a value already typed on the agent's row", async () => {
    db.run(sql`DELETE FROM settings`);
    await db.insert(settingsTable).values({
      key: "app",
      value: {
        settingsSchema: 11,
        anthropicApiKey: "sk-ant-1",
        adapterEnv: { omp: { ANTHROPIC_API_KEY: "mine" } },
      },
    });

    const body = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(body.adapterEnv.omp.ANTHROPIC_API_KEY).toBe("mine");
    expect(body.adapterEnv.cursor.ANTHROPIC_API_KEY).toBe("sk-ant-1");
  });

  it("never writes a harness's env into a settings file", async () => {
    expect((await put({ adapterEnv: { omp: { ANTHROPIC_API_KEY: "sk-ant-1" } } })).statusCode).toBe(200);

    const exported = await app.inject({ method: "GET", url: "/api/settings/export" });
    expect(exported.json().settings.adapterEnv).toBeUndefined();
    // The local row keeps it — the file simply does not travel with it.
    const local = (await app.inject({ method: "GET", url: "/api/settings" })).json();
    expect(local.adapterEnv.omp.ANTHROPIC_API_KEY).toBe("sk-ant-1");
  });
});
