// The acceptance test for the plugin contract: it runs the REAL example plugin
// (`packages/plugin-example`, shipped with the repo and pointed at by hand when
// someone wants to see plugins working) instead of a throwaway fixture. Its
// tool goes through the MCP endpoint the harnesses talk to and its provider
// through the model picker — so when a change to `@acpio/plugin-api`, the
// manifest or the loader breaks plugin authors, this is the test that says so.
//
// The example is TypeScript; the loader imports JS. The suite builds it when
// `dist/server.js` is missing, so `npm test` works on a clean checkout too.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXAMPLE_DIR = "packages/plugin-example";
const MANIFEST = "acpio-plugins.json";

let dir = "";
let example: string;
let manifest: string;
let bundle: string;
let plugins: typeof import("../src/services/plugins.js");
let settings: typeof import("../src/services/settings.js");
let builtinModelOptions: typeof import("@acpio/adapter-builtin").builtinModelOptions;

/** One MCP request against the plugin server, as the route would serve it. */
async function mcp(body: unknown) {
  const server = plugins.findPluginMcpServer("example", "demo");
  if (!server) throw new Error("the example plugin's MCP server is not registered");
  return plugins.handlePluginMcpRequest(body, server);
}

beforeAll(async () => {
  const { REPO_ROOT } = await import("../src/db/client.js");
  example = path.join(REPO_ROOT, EXAMPLE_DIR);
  manifest = path.join(example, MANIFEST);
  bundle = path.join(example, "dist", "server.js");
  if (!fs.existsSync(bundle)) {
    const built = spawnSync("npm", ["run", "build", "-w", "@acpio/plugin-example"], {
      cwd: REPO_ROOT,
      shell: true,
      stdio: "inherit",
    });
    expect(built.status, "npm run build -w @acpio/plugin-example").toBe(0);
  }

  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-plugin-example-"));
  process.env.ACPIO_PLUGINS_DIR = dir;

  const { ensureSchema } = await import("../src/db/ensureSchema.js");
  plugins = await import("../src/services/plugins.js");
  settings = await import("../src/services/settings.js");
  builtinModelOptions = (await import("@acpio/adapter-builtin")).builtinModelOptions;

  await ensureSchema();
  await settings.updateSettings({ pluginsConfig: manifest });
  await plugins.loadPlugins();
});

afterAll(async () => {
  delete process.env.ACPIO_PLUGINS_DIR;
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("the example plugin in packages/plugin-example", () => {
  it("loads from the manifest that ships next to it", async () => {
    const state = await plugins.pluginsState();
    // The app's own plugins load alongside: this test is about the example one.
    const own = state.plugins.filter((p) => !p.shipped);
    expect(own.map((p) => [p.id, p.status, p.mcpServerCount, p.modelProviderCount])).toEqual([
      ["example", "loaded", 1, 1],
    ]);
    expect(state.mcpServers.map((s) => [s.id, s.name, s.configured, s.tools])).toEqual([
      ["plugin:example:demo", "demo", true, 1],
    ]);
  });

  it("serves its tool over the endpoint the harnesses use, with the manifest's config", async () => {
    const listed = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listed.body as { result: { tools: Array<Record<string, unknown>> } }).result.tools;
    // The model reaches it as `mcp__demo_greet`: the server name and the tool
    // name are the two halves the harness composes the tool name from.
    expect(tools.map((t) => t.name)).toEqual(["greet"]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });

    const called = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Мир" } },
    });
    // "Привет" is what acpio-plugins.json sets under config.mcp.demo.greeting.
    expect((called.body as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe(
      "Привет Мир!",
    );
  });

  it("loads the same plugin added by hand, with no config file at all", async () => {
    // What Settings → Plugins → «Add plugin» writes: an id, a path to the
    // bundle and a config object. The config source stays empty.
    await settings.updateSettings({
      pluginsConfig: "",
      pluginEntries: [
        { id: "example", server: bundle, config: { mcp: { demo: { greeting: "Hola" } } } },
      ],
    });
    await plugins.loadPlugins();

    const state = await plugins.pluginsState();
    expect(state.warnings).toEqual([]);
    expect(state.plugins.filter((p) => !p.shipped).map((p) => [p.id, p.status])).toEqual([
      ["example", "loaded"],
    ]);
    expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(200);
    const called = await mcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "greet", arguments: { name: "Мир" } },
    });
    expect((called.body as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe(
      "Hola Мир!",
    );
  });

  it("keeps its models out of the picker until the key it asks for is in", async () => {
    const before = builtinModelOptions(await settings.getSettings());
    expect(before.filter((m) => m.provider.id === "plugin:example:demo")).toEqual([]);

    await settings.updateSettings({ pluginProviders: { "example:demo": { apiKey: "sk-demo" } } });
    const after = builtinModelOptions(await settings.getSettings());
    const demo = after.filter((m) => m.provider.id === "plugin:example:demo");
    expect(demo.map((m) => [m.value, m.name])).toEqual([
      ["plugin:example:demo::demo-small", "Demo Small"],
      ["plugin:example:demo::demo-large", "Demo Large"],
    ]);
    // The endpoint the agent would call is the plugin's, not the user's.
    expect(demo[0].provider.url).toBe("https://example.invalid/v1");
  });
});
