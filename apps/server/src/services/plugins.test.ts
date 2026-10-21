import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The loader reads/writes real files, so the suite points `ACPIO_PLUGINS_DIR` at
 * a temp folder *before* importing the module — the repo's own data/plugins
 * folder must stay untouched.
 */
let dir: string;
let plugins: typeof import("./plugins.js");

/** Only the plugins the test configured: the app's own always load too. */
const own = async () => (await plugins.pluginsState()).plugins.filter((p) => !p.shipped);

const goodEntry = (id: string, server: string | null) => ({
  id,
  version: "1.2.3",
  enabled: true,
  server,
  config: {},
});

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpio-plugins-"));
  process.env.ACPIO_PLUGINS_DIR = dir;
  plugins = await import("./plugins.js");
});

afterAll(async () => {
  delete process.env.ACPIO_PLUGINS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readManifest", () => {
  it("reads a local file and keeps a bad row a warning", async () => {
    const file = path.join(dir, "config.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        schema: 1,
        plugins: [
          { id: "good", version: "1.0.0", server: "./dist/server.js" },
          { id: "Bad Id", server: "./x.js" },
          { id: "good", server: "./y.js" },
          { id: "no-server" },
        ],
      }),
    );
    const read = await plugins.readManifest({ kind: "path", path: file });
    expect(read.entries).toEqual([
      {
        id: "good",
        version: "1.0.0",
        enabled: true,
        server: "./dist/server.js",
        config: {},
      },
      { id: "no-server", version: "0.0.0", enabled: true, server: null, config: {} },
    ]);
    expect(read.warnings).toHaveLength(2);
    expect(read.staleAt).toBeUndefined();
  });

  it("falls back to the cached manifest when the source is gone", async () => {
    const file = path.join(dir, "gone.json");
    await fs.writeFile(file, JSON.stringify({ plugins: [{ id: "cached", server: "./p.js" }] }));
    await plugins.readManifest({ kind: "path", path: file });
    await fs.rm(file);

    const read = await plugins.readManifest({ kind: "path", path: file });
    expect(read.entries.map((e) => e.id)).toEqual(["cached"]);
    expect(read.staleAt).toBeTruthy();
    expect(read.warnings.join(" ")).toContain("source unavailable");
  });

  it("does not reuse a cache written for another source", async () => {
    await expect(
      plugins.readManifest({ kind: "path", path: path.join(dir, "never-existed.json") }),
    ).rejects.toThrow();
  });
});

describe("cachePluginBundle", () => {
  const bundle = `export default () => ({ id: "fixture", extensions: [] });\n`;

  it("names the folder after the version and the content hash", async () => {
    const source = path.join(dir, "src-server.js");
    await fs.writeFile(source, bundle);
    const file = await plugins.cachePluginBundle("fixture", "1.0.0", {
      kind: "path",
      path: source,
    });

    expect(path.relative(dir, file).replace(/\\/g, "/")).toMatch(
      /^fixture\/1\.0\.0-[0-9a-f]{8}\/server\.js$/,
    );
    await expect(fs.readFile(file, "utf8")).resolves.toBe(bundle);
  });

  it("keys on the content, so an unbumped edit still lands in a new folder", async () => {
    const source = path.join(dir, "src-server.js");
    const first = await plugins.cachePluginBundle("fixture", "1.0.0", {
      kind: "path",
      path: source,
    });
    await fs.writeFile(source, `${bundle}// edited\n`);
    const second = await plugins.cachePluginBundle("fixture", "1.0.0", {
      kind: "path",
      path: source,
    });

    expect(second).not.toBe(first);
    await expect(fs.readFile(second, "utf8")).resolves.toContain("// edited");
  });

  it("leaves no temp folder behind", async () => {
    const entries = await fs.readdir(path.join(dir, "fixture"));
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

describe("loadPlugins", () => {
  it("goes from the settings to the registry through the manifest", async () => {
    const { ensureSchema } = await import("../db/ensureSchema.js");
    const { updateSettings } = await import("./settings.js");
    await ensureSchema();

    const folder = path.join(dir, "end-to-end");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, "server.js"),
      `export default (ctx) => ({ id: "e2e", extensions: [{ mcpServer: { id: "s", label: "S",
        create: () => ({ tools: { t: { description: "d", schema: {}, handler: async () => "ok" } } }) } }],
        got: ctx.config });\n`,
    );
    const config = path.join(folder, "config.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: [
          { id: "e2e", version: "2.0.0", server: "./server.js", config: { tenant: "acme" } },
          { id: "off", server: "./server.js", enabled: false },
        ],
      }),
    );
    await updateSettings({ pluginsConfig: config });

    await plugins.loadPlugins();

    // The entry resolved against the manifest's own folder, the off one is state.
    expect(plugins.selectExtensions((x) => x.mcpServer)).toHaveLength(1);
    const state = await plugins.pluginsState();
    expect(state.pendingRestart).toBe(false);
    expect((await own()).map((p) => [p.id, p.status, p.mcpServerCount])).toEqual([
      ["e2e", "loaded", 1],
      ["off", "skipped", 0],
    ]);
    // The server is published as an ordinary MCP config, url and all.
    const servers = plugins.pluginMcpServers({ mcpBuiltinDisabledIds: [] } as never);
    expect(servers.map((s) => [s.id, s.name, s.enabled, s.type])).toEqual([
      ["plugin:e2e:s", "s", true, "remote"],
    ]);
    expect(servers[0].url).toContain("/api/mcp/plugin/e2e/s?token=");
    expect(state.mcpServers.map((s) => [s.id, s.configured, s.tools])).toEqual([
      ["plugin:e2e:s", true, 1],
    ]);
    // The same global switch the built-in servers ride.
    expect(
      plugins.pluginMcpServers({ mcpBuiltinDisabledIds: ["plugin:e2e:s"] } as never)[0].enabled,
    ).toBe(false);
  });

  it("hands the skill folders a plugin ships, with the rules its skills word", async () => {
    const { updateSettings, getSettings } = await import("./settings.js");
    const folder = path.join(dir, "skills");
    await fs.mkdir(path.join(folder, "skills"), { recursive: true });
    // A bundle that contributes nothing but a folder, declaring what its skill
    // states itself — the SKILL.md stays the author's file, untouched.
    await fs.writeFile(
      path.join(folder, "server.js"),
      `export default () => ({ id: "skiller", extensions: [
        { skillPath: { path: "./skills", supersedes: { ponytail: ["smallest-change"] } } },
        { skillPath: "./skills" },
      ] });
`,
    );
    const config = path.join(folder, "config.json");
    await fs.writeFile(
      config,
      JSON.stringify({ plugins: [{ id: "skiller", version: "1.0.0", server: "./server.js" }] }),
    );
    await updateSettings({ pluginsConfig: config, pluginEntries: [] });

    await plugins.loadPlugins();

    // One folder per path, and the two claims about it merged rather than doubled.
    const mine = path.join(folder, "skills");
    const folders = plugins.pluginSkillFolders();
    expect(folders.filter((f) => f.path === mine)).toEqual([
      { path: mine, supersedes: { ponytail: ["smallest-change"] } },
    ]);
    // The shipped ponytail declares the rule its skill words; it is in the same list.
    expect(folders.filter((f) => f.supersedes.ponytail?.includes("smallest-change"))).toHaveLength(2);
    // The agent reads them off the settings, like the providers a plugin ships.
    expect((await getSettings()).pluginSkills).toEqual(folders);
    expect((await own()).map((p) => [p.id, p.skillCount])).toEqual([["skiller", 2]]);
  });

  it("keeps an unconfigured server out of the chat and a colliding name out of the registry", async () => {
    const { updateSettings } = await import("./settings.js");
    const folder = path.join(dir, "collisions");
    await fs.mkdir(folder, { recursive: true });
    const contribution = (serverId: string, label: string, configured: boolean) =>
      `{ mcpServer: { id: "${serverId}", label: "${label}",
        isConfigured: () => ${configured}, create: () => ({ tools: {} }) } }`;
    for (const [name, points] of [
      ["first", contribution("dup", "First", true)],
      ["second", contribution("dup", "Second", true)],
      ["needs-key", contribution("gated", "Gated", false)],
    ] as const) {
      await fs.mkdir(path.join(folder, name), { recursive: true });
      await fs.writeFile(
        path.join(folder, name, "server.js"),
        `export default () => ({ id: "${name}", extensions: [${points}] });\n`,
      );
    }
    const config = path.join(folder, "config.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: ["first", "second", "needs-key"].map((id) => ({
          id,
          version: "1.0.0",
          server: `./${id}/server.js`,
        })),
      }),
    );
    await updateSettings({ pluginsConfig: config });
    await plugins.loadPlugins();

    const state = await plugins.pluginsState();
    expect(state.mcpServers.map((s) => [s.id, s.configured, s.error ?? ""])).toEqual([
      ["plugin:first:dup", true, ""],
      ["plugin:second:dup", false, 'server name "dup" is already taken'],
      ["plugin:needs-key:gated", false, ""],
    ]);
    // Neither the colliding one nor the one without its config reaches a chat.
    expect(plugins.pluginMcpServers({ mcpBuiltinDisabledIds: [] } as never).map((s) => s.id)).toEqual([
      "plugin:first:dup",
    ]);
  });

  it("reports a source that cannot be read instead of throwing", async () => {
    const { updateSettings } = await import("./settings.js");
    await updateSettings({ pluginsConfig: path.join(dir, "nowhere", "config.json") });

    await plugins.loadPlugins();

    const state = await plugins.pluginsState();
    // Nothing from the source — the app's own `skillPath` is not its doing.
    expect(plugins.selectExtensions((x) => x.mcpServer)).toEqual([]);
    expect(await own()).toEqual([]);
    expect(state.warnings.join(" ")).toContain("could not read the plugin source");
    expect(state.pendingRestart).toBe(false);
  });

  it("loads a plugin added by hand, with no config file at all", async () => {
    const { updateSettings } = await import("./settings.js");
    const folder = path.join(dir, "hand-added");
    await fs.mkdir(folder, { recursive: true });
    const bundle = path.join(folder, "server.js");
    await fs.writeFile(
      bundle,
      `export default (ctx) => ({ id: "hand", extensions: [{ mcpServer: { id: "one", label: "One",
        create: () => ({ tools: { ping: { description: "p", schema: { type: "object" }, handler: async (i) => "pong " + ctx.config.token } } }) } }] });\n`,
    );

    // No config source at all — the default file does not exist, and that is fine.
    // (An earlier test left one in that spot; the default source is this folder.)
    await fs.rm(path.join(dir, "config.json"), { force: true });
    await updateSettings({
      pluginsConfig: "",
      pluginEntries: [{ id: "hand", server: bundle, config: { token: "t1" } }],
    });
    await plugins.loadPlugins();

    const state = await plugins.pluginsState();
    expect((await own()).map((p) => [p.id, p.status])).toEqual([["hand", "loaded"]]);
    expect(state.warnings).toEqual([]);
    const server = plugins.findPluginMcpServer("hand", "one");
    expect(server).toBeDefined();
    const called = await plugins.handlePluginMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ping", arguments: {} } },
      server!,
    );
    // The config typed in the settings row is what the plugin was created with.
    expect((called.body as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe(
      "pong t1",
    );
    // Editing it (here: a new path) waits for the restart, as everything does.
    await updateSettings({
      pluginEntries: [{ id: "hand", server: path.join(folder, "other.js"), config: {} }],
    });
    expect((await plugins.pluginsState()).pendingRestart).toBe(true);
  });

  it("lets a hand-added plugin win over the same id in the file, and says so", async () => {
    const { updateSettings } = await import("./settings.js");
    const folder = path.join(dir, "both");
    await fs.mkdir(folder, { recursive: true });
    for (const name of ["from-file", "from-row"]) {
      await fs.writeFile(
        path.join(folder, `${name}.js`),
        `export default () => ({ id: "${name}", extensions: [] });\n`,
      );
    }
    const config = path.join(folder, "config.json");
    await fs.writeFile(
      config,
      JSON.stringify({
        plugins: [
          { id: "same", version: "1.0.0", server: "./from-file.js" },
          { id: "same", version: "2.0.0", server: "./from-file.js" },
        ],
      }),
    );
    await updateSettings({
      pluginsConfig: config,
      pluginEntries: [
        { id: "same", server: path.join(folder, "from-row.js") },
        { id: "no server", server: "" },
      ],
    });
    await plugins.loadPlugins();

    const state = await plugins.pluginsState();
    // The row's own version is what proves which of the two was taken.
    const loaded = await own();
    expect(loaded.map((p) => [p.id, p.version])).toEqual([
      ["same", "0.0.0"],
      ["no server", "0.0.0"],
    ]);
    expect(state.warnings.join(" ")).toContain('plugin "same" is listed twice');
    expect(loaded[1].error).toContain("must be [a-z0-9-]");
  });
});

describe("loadPluginBundle", () => {
  it("counts what the plugin contributes", async () => {
    const source = path.join(dir, "contributing.js");
    await fs.writeFile(
      source,
      `export default (ctx) => ({ id: "fixture", extensions: [
        { mcpServer: [{ id: "a", label: "A", create: () => ({ tools: {} }) }, { id: "b", label: "B", create: () => ({ tools: {} }) }] },
        { modelProvider: { id: "p", label: "P", baseUrl: "https://x/v1", models: [] } },
      ], home: ctx.home });\n`,
    );
    const file = await plugins.cachePluginBundle("contributing", "1.0.0", {
      kind: "path",
      path: source,
    });
    const loaded = await plugins.loadPluginBundle(goodEntry("contributing", "./x.js"), file, path.dirname(file));

    expect(loaded.status).toBe("loaded");
    expect(loaded.mcpServerCount).toBe(2);
    expect(loaded.modelProviderCount).toBe(1);
  });

  it("reports a bundle that throws on import instead of failing the boot", async () => {
    const source = path.join(dir, "broken.js");
    await fs.writeFile(source, `throw new Error("boom");\n`);
    const file = await plugins.cachePluginBundle("broken", "1.0.0", {
      kind: "path",
      path: source,
    });
    const loaded = await plugins.loadPluginBundle(goodEntry("broken", "./x.js"), file, path.dirname(file));

    expect(loaded.status).toBe("failed");
    expect(loaded.error).toContain("boom");
    expect(loaded.extensions).toEqual([]);
  });

  it("reports a bundle with no default export", async () => {
    const source = path.join(dir, "empty.js");
    await fs.writeFile(source, `export const nothing = 1;\n`);
    const file = await plugins.cachePluginBundle("empty", "1.0.0", {
      kind: "path",
      path: source,
    });
    const loaded = await plugins.loadPluginBundle(goodEntry("empty", "./x.js"), file, path.dirname(file));

    expect(loaded.status).toBe("failed");
    expect(loaded.error).toContain("default export");
  });
});
