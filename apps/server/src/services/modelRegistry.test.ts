// Registry loader for built-in model context windows: local HTTP for the
// happy path, a dead port for the failure path.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { clearModelRegistryCache, loadModelRegistry } from "./modelRegistry.js";

/** Bound TCP port of a listening server (fails the test otherwise). */
function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

let server: http.Server;
let base = "";
let fixture: unknown;
/** Registry downloads seen by the server — proves caching and skipping. */
let hits = 0;
/** A port that was listening once and is closed afterwards (connection refused). */
let closedUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/registry.json") {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fixture));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}`;
  fixture = {
    "vendor-a": {
      api: `${base}/v1`,
      models: {
        "Kimi-K3": { limit: { context: 1_048_576 } },
        "no-limit": { limit: {} },
        "no-row": null,
        tri: { limit: { context: 64_000 } },
      },
    },
    "vendor-b": {
      api: `${base}/v2`,
      models: {
        "kimi-k3": { limit: { context: 999_999 } },
        dupe: { limit: { context: 1_000 } },
        tri: { limit: { context: 7_000 } },
      },
    },
    "vendor-c": {
      api: base,
      models: {
        dupe: { limit: { context: 2_000 } },
        tri: { limit: { context: 7_000 } },
        "prefixed/name": { limit: { context: 42 } },
      },
    },
  };

  const throwaway = http.createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  closedUrl = `http://127.0.0.1:${portOf(throwaway)}/registry.json`;
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearModelRegistryCache();
  hits = 0;
});

describe("loadModelRegistry", () => {
  it("scopes windows to the provider base URL, tolerating slash and case", async () => {
    const registry = await loadModelRegistry(`${base}/registry.json`);
    expect(registry).not.toBeNull();
    expect(registry!.contextFor(`${base}/v1`, "kimi-k3")).toBe(1_048_576);
    expect(registry!.contextFor(`${base}/v1/`, "Kimi-K3")).toBe(1_048_576);
    expect(registry!.contextFor(`${base}/v1/models`, "moonshotai/Kimi-K3")).toBe(1_048_576);
    // Rows without a limit are not windows, and another base URL has its own list.
    expect(registry!.contextFor(`${base}/v1`, "no-limit")).toBeUndefined();
    expect(registry!.contextFor(`${base}/v1`, "no-row")).toBeUndefined();
    expect(registry!.contextFor(`${base}/v2`, "kimi-k3")).toBe(999_999);
    expect(registry!.contextFor(`${base}`, "prefixed/name")).toBe(42);
    expect(registry!.contextFor(`${base}`, "name")).toBe(42);
  });

  it("falls back to the global map: most frequent window wins, ties to smaller", async () => {
    const registry = await loadModelRegistry(`${base}/registry.json`);
    expect(registry!.contextOf("dupe")).toBe(1_000); // 1000 vs 2000 — tie, smaller
    expect(registry!.contextOf("tri")).toBe(7_000); // two votes for 7000, one for 64000
    expect(registry!.contextOf("KIMI-K3")).toBe(999_999); // no base context — global only
    expect(registry!.contextOf("unknown-model")).toBeUndefined();
    // Unknown base URL never sees the scoped map.
    expect(registry!.contextFor("https://elsewhere.example/v1", "kimi-k3")).toBeUndefined();
  });

  it("downloads once per URL and skips an explicitly disabled registry", async () => {
    await loadModelRegistry(`${base}/registry.json`);
    await loadModelRegistry(`${base}/registry.json`);
    expect(hits).toBe(1);

    const envUrl = process.env.ACP_MODELS_REGISTRY_URL;
    process.env.ACP_MODELS_REGISTRY_URL = "";
    try {
      expect(await loadModelRegistry()).toBeNull();
      expect(hits).toBe(1);
    } finally {
      if (envUrl === undefined) delete process.env.ACP_MODELS_REGISTRY_URL;
      else process.env.ACP_MODELS_REGISTRY_URL = envUrl;
    }
  });

  it("returns null when the registry cannot be read", async () => {
    expect(await loadModelRegistry(closedUrl)).toBeNull();
    expect(await loadModelRegistry("not a url")).toBeNull();
  });
});
