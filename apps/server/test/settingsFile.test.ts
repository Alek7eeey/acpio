// A setting is only done when a settings file carries it: Export writes the
// stored object, Import keeps what `SETTING_KEYS` recognises, and both are
// silent about a key that is missing from either side. This walks the file the
// way a user does — set the value, export, import it elsewhere.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, useResetDb } from "./test-utils.js";

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
