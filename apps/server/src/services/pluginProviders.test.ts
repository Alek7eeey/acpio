import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

/**
 * A provider a plugin ships, through the settings: the plugin's half (endpoint,
 * recommended models) arrives merged, the user's half (key, edits, additions)
 * lives in `pluginProviders` and survives an update of the plugin.
 */
let dir: string;
let config: string;
let plugins: typeof import("./plugins.js");
let getSettings: typeof import("./settings.js").getSettings;
let updateSettings: typeof import("./settings.js").updateSettings;
let readStored: () => Promise<Record<string, unknown>>;

/** The fixture bundle; `extraModel` is what a plugin update adds. */
function bundle(extraModel = false): string {
  return `export default () => ({
  id: "e2e",
  extensions: [{ modelProvider: {
    id: "zen",
    label: "Zen",
    baseUrl: "https://zen.example/v1",
    apiKeyHint: "https://zen.example/keys",
    models: [
      { id: "demo-small", label: "Demo Small", contextWindow: 131072 },
      { id: "demo-large", label: "Demo Large", contextWindow: 262144 }${extraModel ? ',\n      { id: "demo-xl", label: "Demo XL", contextWindow: 524288 }' : ""},
    ],
  } }],
});
`;
}

async function writeFixture(extraModel = false) {
  await fs.mkdir(path.join(dir, "bundle"), { recursive: true });
  await fs.writeFile(path.join(dir, "bundle", "server.js"), bundle(extraModel));
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpio-plugin-providers-"));
  process.env.ACPIO_PLUGINS_DIR = dir;
  await writeFixture();
  config = path.join(dir, "config.json");
  await fs.writeFile(
    config,
    JSON.stringify({ plugins: [{ id: "e2e", version: "1.0.0", server: "./bundle/server.js" }] }),
  );

  const { ensureSchema } = await import("../db/ensureSchema.js");
  plugins = await import("./plugins.js");
  const settings = await import("./settings.js");
  getSettings = settings.getSettings;
  updateSettings = settings.updateSettings;
  const { db } = await import("../db/client.js");
  const { settings: settingsTable } = await import("../db/schema.js");
  readStored = async () => {
    const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, "app")).limit(1);
    return (rows[0]?.value ?? {}) as Record<string, unknown>;
  };

  await ensureSchema();
  await updateSettings({ pluginsConfig: config });
  await plugins.loadPlugins();
});

afterAll(async () => {
  delete process.env.ACPIO_PLUGINS_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

const providerRow = async () => (await getSettings()).builtinProviders.find((p) => p.pluginId === "e2e:zen");

describe("a provider a plugin ships", () => {
  it("arrives with the plugin's endpoint and models, and no key", async () => {
    const row = await providerRow();
    expect(row).toMatchObject({
      id: "plugin:e2e:zen",
      name: "Zen",
      url: "https://zen.example/v1",
      apiKey: "",
      apiKeyHint: "https://zen.example/keys",
      pluginId: "e2e:zen",
    });
    // Recommended models come enabled; without a key the provider stays out of
    // the pickers, which is what `enabled: false` means everywhere downstream.
    expect(row?.models.map((m) => [m.id, m.enabled])).toEqual([
      ["demo-small", true],
      ["demo-large", true],
    ]);
    expect(row?.enabled).toBe(false);
  });

  it("turns on as soon as the user's key is there", async () => {
    await updateSettings({ pluginProviders: { "e2e:zen": { apiKey: "sk-test" } } });
    const row = await providerRow();
    expect(row?.apiKey).toBe("sk-test");
    expect(row?.enabled).toBe(true);
  });

  it("keeps the user's edits and additions over the recommended list", async () => {
    await updateSettings({
      pluginProviders: {
        "e2e:zen": {
          apiKey: "sk-test",
          models: [
            { id: "demo-small", label: "Mine", contextWindow: 2000 },
            { id: "my-own", label: "Own", contextWindow: 8000 },
          ],
        },
      },
    });
    const row = await providerRow();
    expect(row?.models.map((m) => [m.id, m.label, m.contextWindow])).toEqual([
      ["demo-small", "Mine", 2000],
      ["demo-large", "Demo Large", 262144],
      ["my-own", "Own", 8000],
    ]);
  });

  it("adds a model a plugin update brings, without touching the edits", async () => {
    await writeFixture(true);
    await plugins.loadPlugins();

    // The plugin's own order holds — its new row lands where it put it — and
    // the user's additions stay at the end.
    const row = await providerRow();
    expect(row?.models.map((m) => [m.id, m.label])).toEqual([
      ["demo-small", "Mine"],
      ["demo-large", "Demo Large"],
      ["demo-xl", "Demo XL"],
      ["my-own", "Own"],
    ]);
  });

  it("is never stored: a form submit carrying it does not duplicate or freeze it", async () => {
    // A settings form posts the whole provider list, plugin rows included.
    await updateSettings({ builtinProviders: (await getSettings()).builtinProviders });

    const stored = await readStored();
    expect(
      (stored.builtinProviders as Array<{ pluginId?: string }>).filter((p) => p.pluginId),
    ).toEqual([]);
    expect((await getSettings()).builtinProviders.filter((p) => p.pluginId)).toHaveLength(1);
  });
});
