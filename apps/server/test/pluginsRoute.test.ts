// The plugin MCP endpoint over the real route table: the token gate, an
// unknown server, tools/list, tools/call (result, error, clip) and the
// JSON-RPC edges. The plugin itself is a fixture bundle loaded from a temp
// folder, so nothing here touches data/plugins.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const BUNDLE = `export default () => ({
  id: "e2e",
  extensions: [{ mcpServer: { id: "s", label: "E2E tools", create: () => ({ tools: {
    echo: {
      description: "Echo the text back",
      schema: { type: "object", properties: { text: { type: "string" } } },
      readOnly: true,
      handler: async (input) => String(input?.text ?? ""),
    },
    big: { description: "More than the host clips", schema: { type: "object" }, handler: async () => "x".repeat(40000) },
    boom: { description: "Always fails", schema: { type: "object" }, handler: async () => { throw new Error("nope"); } },
  } }) } }],
});`;

let app: FastifyInstance;
let dir = "";
let token = "";
let plugins: typeof import("../src/services/plugins.js");

async function mcp(url: string, body: unknown) {
  return app.inject({
    method: "POST",
    url,
    payload: body as Record<string, unknown>,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpio-plugins-route-"));
  process.env.ACPIO_PLUGINS_DIR = dir;
  await fs.mkdir(path.join(dir, "bundle"), { recursive: true });
  await fs.writeFile(path.join(dir, "bundle", "server.js"), BUNDLE);
  const config = path.join(dir, "config.json");
  await fs.writeFile(
    config,
    JSON.stringify({ plugins: [{ id: "e2e", version: "1.0.0", server: "./bundle/server.js" }] }),
  );

  // Imported after the env is set: the loader reads its folder at import time.
  const { buildApp } = await import("./test-utils.js");
  plugins = await import("../src/services/plugins.js");
  const { updateSettings } = await import("../src/services/settings.js");
  const { MCP_TOKEN } = await import("../src/services/mcpToken.js");

  app = await buildApp();
  await updateSettings({ pluginsConfig: config });
  await plugins.loadPlugins();
  token = MCP_TOKEN;
});

afterAll(async () => {
  await app?.close();
  delete process.env.ACPIO_PLUGINS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("POST /api/mcp/plugin/:pluginId/:serverId", () => {
  const url = (extra = `?token=${""}`) => `/api/mcp/plugin/e2e/s${extra}`;

  it("refuses a request without this boot's token", async () => {
    expect((await mcp(url(), { jsonrpc: "2.0", id: 1, method: "initialize" })).statusCode).toBe(403);
    expect(
      (await mcp(url("?token=wrong"), { jsonrpc: "2.0", id: 1, method: "initialize" })).statusCode,
    ).toBe(403);
  });

  it("answers 404 for a server that is not registered", async () => {
    const res = await mcp(`/api/mcp/plugin/e2e/nope?token=${token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(res.statusCode).toBe(404);
  });

  it("introduces itself under the server name tools are built from", async () => {
    const res = await mcp(url(`?token=${token}`), { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.name).toBe("s");
  });

  it("lists the plugin's tools with the read-only hint", async () => {
    const res = await mcp(url(`?token=${token}`), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = res.json().result.tools as Array<{ name: string; annotations?: unknown }>;
    expect(tools.map((t) => t.name)).toEqual(["echo", "big", "boom"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(tools[1].annotations).toBeUndefined();
  });

  it("runs a tool and returns its text", async () => {
    const res = await mcp(url(`?token=${token}`), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(res.json().result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("turns a throwing tool into an error result, not a broken session", async () => {
    const res = await mcp(url(`?token=${token}`), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("nope");
  });

  it("clips a big result and says so", async () => {
    const res = await mcp(url(`?token=${token}`), {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "big", arguments: {} },
    });
    const text = res.json().result.content[0].text as string;
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain("truncated");
  });

  it("answers an unknown tool with the list, not a protocol error", async () => {
    const res = await mcp(url(`?token=${token}`), {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "wat", arguments: {} },
    });
    expect(res.json().result.isError).toBe(true);
    expect(res.json().result.content[0].text).toContain("echo");
  });

  it("rejects an unsupported method and accepts a notification", async () => {
    const bad = await mcp(url(`?token=${token}`), { jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(bad.json().error.code).toBe(-32601);

    const note = await mcp(url(`?token=${token}`), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note.statusCode).toBe(202);
  });

  it("reports the server in the MCP status list (a probe against the endpoint)", async () => {
    const { getMcpStatus } = await import("../src/services/mcpStatus.js");
    // No listener in an inject app, so the probe answers false — what matters is
    // that the plugin server is in the list at all.
    expect(await getMcpStatus()).toHaveProperty("plugin:e2e:s");
  });

  it("publishes the server for the MCP switches with its tool count", async () => {
    const state = await plugins.pluginsState();
    expect(state.mcpServers).toEqual([
      {
        id: "plugin:e2e:s",
        name: "s",
        label: "E2E tools",
        pluginId: "e2e",
        serverId: "s",
        configured: true,
        tools: 3,
      },
    ]);
  });
});
