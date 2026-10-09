// Catalog fetcher for Settings → Built-in agent: real HTTP against a local
// server so header, URL and payload handling are exercised end to end.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { fetchBuiltinModelCatalog } from "./builtinModelCatalog.js";
import { clearModelRegistryCache } from "./modelRegistry.js";

/** Bound TCP port of a listening server (fails the test otherwise). */
function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

let server: http.Server;
let base = "";
/** Port that was listening once and is closed afterwards (connection refused). */
let closedPort = 0;
/** Saved across the file: these tests use the local fixture, never the real registry. */
let savedRegistryUrl: string | undefined;

beforeAll(async () => {
  savedRegistryUrl = process.env.ACP_MODELS_REGISTRY_URL;
  process.env.ACP_MODELS_REGISTRY_URL = "";
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const json = (payload: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith("/v1/models")) {
      json({
        object: "list",
        data: [
          { id: "gpt-5.2", name: "GPT 5.2" },
          { id: "grok-4.6", context_length: 256_000 },
          { id: "gpt-5.2", name: "duplicate id" },
          { name: "row without id" },
          { id: 17 },
          // Same id as its display name → no redundant label.
          { id: "same", name: "same" },
        ],
      });
      return;
    }
    if (url.startsWith("/bare/models")) {
      json([{ id: "a" }, { model: "b" }, { id: "a" }]);
      return;
    }
    if (url.startsWith("/wrapped/models")) {
      json({ models: [{ id: "m1", context_window: 1234 }] });
      return;
    }
    if (url.startsWith("/html/models")) {
      res.setHeader("content-type", "text/html");
      res.end("<html>nope</html>");
      return;
    }
    if (url.startsWith("/registry.json")) {
      json({
        "vendor-a": {
          api: `${base}/enrich`,
          models: {
            "scoped-model": { limit: { context: 200_000 } },
            reported: { limit: { context: 999_999 } },
          },
        },
        "vendor-b": {
          api: `${base}/elsewhere`,
          models: {
            "scoped-model": { limit: { context: 111_111 } },
            "global-model": { limit: { context: 300_000 } },
          },
        },
      });
      return;
    }
    if (url.startsWith("/enrich/models")) {
      json({
        data: [
          { id: "scoped-model" },
          { id: "global-model" },
          { id: "reported", context_length: 64_000 },
          { id: "strange-model" },
        ],
      });
      return;
    }
    if (url.startsWith("/boom/models")) {
      res.statusCode = 500;
      res.end("server exploded");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}`;

  // A listener that goes away → fetch fails with ECONNREFUSED.
  const throwaway = http.createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  closedPort = portOf(throwaway);
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
});

afterAll(async () => {
  if (savedRegistryUrl === undefined) delete process.env.ACP_MODELS_REGISTRY_URL;
  else process.env.ACP_MODELS_REGISTRY_URL = savedRegistryUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clearModelRegistryCache();
});

describe("fetchBuiltinModelCatalog", () => {
  it("parses an OpenAI /models list, dropping id-less and duplicate rows", async () => {
    const result = await fetchBuiltinModelCatalog(`${base}/v1`, "sk-test");
    expect(result).toEqual({
      ok: true,
      models: [
        { id: "gpt-5.2", label: "GPT 5.2" },
        { id: "grok-4.6", contextWindow: 256_000 },
        { id: "same" },
      ],
    });
  });

  it("sends the key as a Bearer token and never duplicates /models", async () => {
    let auth = "";
    let path = "";
    const probe = http.createServer((req, res) => {
      auth = req.headers.authorization ?? "";
      path = req.url ?? "";
      res.end(JSON.stringify({ data: [{ id: "x" }] }));
    });
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = portOf(probe);
    try {
      const withKey = await fetchBuiltinModelCatalog(`http://127.0.0.1:${port}/v1/`, "sk-abc");
      expect(withKey.ok).toBe(true);
      expect(auth).toBe("Bearer sk-abc");
      expect(path).toBe("/v1/models");

      const withoutKey = await fetchBuiltinModelCatalog(
        `http://127.0.0.1:${port}/v1/models`,
        "",
      );
      expect(withoutKey.ok).toBe(true);
      expect(auth).toBe("");
      expect(path).toBe("/v1/models");
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  });

  it("accepts a bare array (with a `model` key) and a `models` wrapper", async () => {
    const bare = await fetchBuiltinModelCatalog(`${base}/bare`, "");
    expect(bare).toEqual({ ok: true, models: [{ id: "a" }, { id: "b" }] });

    const wrapped = await fetchBuiltinModelCatalog(`${base}/wrapped`, "");
    expect(wrapped).toEqual({ ok: true, models: [{ id: "m1", contextWindow: 1234 }] });
  });

  it("reports why the endpoint could not be read", async () => {
    expect(await fetchBuiltinModelCatalog("", "sk-test")).toEqual({
      ok: false,
      code: "noEndpoint",
    });
    expect((await fetchBuiltinModelCatalog("not a url", "")).ok).toBe(false);
    const badUrl = await fetchBuiltinModelCatalog("file:///tmp/models", "");
    expect(badUrl).toMatchObject({ ok: false, code: "badUrl" });

    const html = await fetchBuiltinModelCatalog(`${base}/html`, "");
    expect(html).toEqual({ ok: false, code: "notJson" });

    const boom = await fetchBuiltinModelCatalog(`${base}/boom`, "");
    expect(boom).toEqual({ ok: false, code: "httpStatus", detail: "500" });

    const missing = await fetchBuiltinModelCatalog(`${base}/nope`, "");
    expect(missing).toEqual({ ok: false, code: "httpStatus", detail: "404" });
  });

  it("fills unreported windows from the model registry, endpoint values winning", async () => {
    const result = await fetchBuiltinModelCatalog(`${base}/enrich`, "", {
      registryUrl: `${base}/registry.json`,
    });
    expect(result).toEqual({
      ok: true,
      models: [
        // Scoped to this endpoint's base URL — the other provider's 111111
        // for the same id must not leak in.
        { id: "scoped-model", contextWindow: 200_000 },
        // Unknown to the scoped provider, found by id across the registry.
        { id: "global-model", contextWindow: 300_000 },
        // Reported by the endpoint: the registry must not override it.
        { id: "reported", contextWindow: 64_000 },
        // Known to neither source: left exactly as bare as it came.
        { id: "strange-model" },
      ],
    });
  });

  it("keeps the catalog readable when the registry is unavailable", async () => {
    const result = await fetchBuiltinModelCatalog(`${base}/enrich`, "", {
      registryUrl: `http://127.0.0.1:${closedPort}/registry.json`,
    });
    expect(result).toEqual({
      ok: true,
      models: [
        { id: "scoped-model" },
        { id: "global-model" },
        { id: "reported", contextWindow: 64_000 },
        { id: "strange-model" },
      ],
    });
  });

  it("fails as unreachable when nothing listens on the port", async () => {
    const result = await fetchBuiltinModelCatalog(`http://127.0.0.1:${closedPort}`, "");
    if (result.ok) throw new Error("expected the fetch to fail on a closed port");
    expect(result.code).toBe("unreachable");
    expect(result.detail).toBeTruthy();
  });
});
