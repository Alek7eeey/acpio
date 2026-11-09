// The one-time effort seed: after an update that adds the knob, the levels are
// fetched on their own once, and never again — later refreshes are the
// Settings button's job.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { seedBuiltinEffortsOnce } from "./builtinEffortsSeed.js";
import { clearModelRegistryCache } from "./modelRegistry.js";
import { getSettings, updateSettings } from "./settings.js";

let server: http.Server;
let base = "";
/** Requests the fixture endpoint saw — the point of "once per install". */
let calls = 0;
let savedRegistryUrl: string | undefined;

function portOf(srv: http.Server): number {
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

beforeAll(async () => {
  // Every test file gets a private in-memory DB; the schema is created lazily.
  const { ensureSchema } = await import("../db/ensureSchema.js");
  await ensureSchema();
  savedRegistryUrl = process.env.ACP_MODELS_REGISTRY_URL;
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const json = (payload: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith("/registry.json")) {
      json({
        "vendor-a": {
          api: `${base}/enrich`,
          models: {
            "m-one": { reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
            "m-two": { reasoning_options: [{ type: "toggle" }] },
          },
        },
      });
      return;
    }
    if (url.startsWith("/enrich/v1/models") || url.startsWith("/enrich/models")) {
      calls += 1;
      json({ object: "list", data: [{ id: "m-one" }, { id: "m-two" }] });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}`;
  process.env.ACP_MODELS_REGISTRY_URL = `${base}/registry.json`;
});

afterAll(async () => {
  process.env.ACP_MODELS_REGISTRY_URL = savedRegistryUrl ?? "";
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = 0;
  clearModelRegistryCache();
});

describe("seeding effort levels on the first boot", () => {
  it("fills the rows that know none, keeps the known ones, and marks the install", async () => {
    await updateSettings({
      builtinEffortsSeeded: false,
      builtinProviders: [
        {
          id: "p1",
          name: "Fixture",
          url: `${base}/enrich`,
          apiKey: "k",
          models: [
            { id: "m-one", label: "One", contextWindow: 1000, enabled: true },
            { id: "m-two", label: "Two", contextWindow: 1000, enabled: true },
            { id: "m-keep", label: "Keep", contextWindow: 1000, enabled: true, efforts: ["low"] },
          ],
        },
      ],
    });

    expect(await seedBuiltinEffortsOnce()).toBe(1);

    const after = await getSettings();
    const models = after.builtinProviders[0].models;
    expect(models.find((m) => m.id === "m-one")?.efforts).toEqual(["low", "high", "max"]);
    // The registry states no levels for this one: the row keeps none.
    expect(models.find((m) => m.id === "m-two")?.efforts ?? []).toEqual([]);
    // Already known — the seed never rewrites a row it did not have to fill.
    expect(models.find((m) => m.id === "m-keep")?.efforts).toEqual(["low"]);
    expect(after.builtinEffortsSeeded).toBe(true);
  });

  it("does nothing on the next boot — the flag turns the pass off", async () => {
    const before = calls;
    expect(await seedBuiltinEffortsOnce()).toBe(0);
    expect(calls).toBe(before);
  });

  it("leaves the flag unset when the endpoint cannot be reached, so the next boot retries", async () => {
    await updateSettings({
      builtinEffortsSeeded: false,
      builtinProviders: [
        {
          id: "p1",
          name: "Dead",
          url: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: [{ id: "m-one", label: "One", contextWindow: 1000, enabled: true }],
        },
      ],
    });

    expect(await seedBuiltinEffortsOnce()).toBe(0);
    expect((await getSettings()).builtinEffortsSeeded).toBe(false);
  });

  it("marks the install when there is nothing to ask", async () => {
    await updateSettings({ builtinEffortsSeeded: false, builtinProviders: [] });
    expect(await seedBuiltinEffortsOnce()).toBe(0);
    expect((await getSettings()).builtinEffortsSeeded).toBe(true);
  });
});
