import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProviderKeyCursors, providerFetch } from "./keys.js";
import { resetWireLogState, sharedPrefix, withWireLog, wireLogDir } from "./wireLog.js";

/** A response shape the SDK/most relays answer with: JSON plus usage. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("wire log", () => {
  let dir = "";
  const saved = { dir: process.env.ACPIO_WIRE_LOG_DIR, mode: process.env.ACPIO_WIRE_LOG };

  beforeEach(() => {
    resetProviderKeyCursors();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-log-"));
    process.env.ACPIO_WIRE_LOG_DIR = dir;
    process.env.ACPIO_WIRE_LOG = "1";
    resetWireLogState();
  });

  afterEach(() => {
    if (saved.dir === undefined) delete process.env.ACPIO_WIRE_LOG_DIR;
    else process.env.ACPIO_WIRE_LOG_DIR = saved.dir;
    if (saved.mode === undefined) delete process.env.ACPIO_WIRE_LOG;
    else process.env.ACPIO_WIRE_LOG = saved.mode;
    resetWireLogState();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const lines = (): any[] =>
    fs
      .readFileSync(path.join(dir, "sess-1.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it("records the request's head hashes, the key fingerprint and the answer's usage", async () => {
    const fetch = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens: 5 } })) as typeof globalThis.fetch,
    );
    await fetch("https://relay.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-key" },
      body: JSON.stringify({
        model: "m",
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [request, response] = lines();
    expect(request.kind).toBe("request");
    expect(request.messages).toBe(2);
    expect(request.key).toHaveLength(8);
    expect(request.key).not.toContain("secret");
    expect(request.headers.authorization).toBe(`Bearer <${request.key}>`);
    expect(response.kind).toBe("response");
    expect(response.usage).toEqual({ input: 100, cached: 90, output: 5 });
  });

  it("names how much of the prefix matches the request before it", async () => {
    const base = (async () => jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 1 } })) as typeof globalThis.fetch;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "legacy" }, base);
    const head = [{ role: "user" as const, content: "one" }];
    const call = (messages: unknown[], key = "k1") =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "m", messages }),
      });

    await call(head);
    await call([...head, { role: "assistant", content: "two" }]);
    // A rewritten head is what kills a provider's cache: the shared prefix
    // collapses to zero even though every message after it is new anyway.
    await call([{ role: "user", content: "one!" }, { role: "assistant", content: "two" }], "k2");

    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[0].prefixSame).toBeNull(); // nothing to compare against
    expect(requests[1].prefixSame).toBe(1); // the head survived, the tail grew
    expect(requests[2].prefixSame).toBe(0); // the head changed: full re-read
    expect(requests[2].keyChanged).toBe(true);
  });

  it("keeps the head hashes that tell a system-prompt change from a tool-list change", async () => {
    const base = (async () => jsonResponse({})) as typeof globalThis.fetch;
    const fetch = withWireLog({ sessionId: "sess-1", providerId: "legacy" }, base);
    const send = (system: string, tools: unknown[]) =>
      fetch("https://relay.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", system, tools, messages: [{ role: "user", content: "x" }] }),
      });
    await send("rules", [{ name: "bash" }]);
    await send("rules", [{ name: "bash" }]);
    await send("rules", [{ name: "bash" }, { name: "read" }]);
    const requests = lines().filter((line) => line.kind === "request");
    expect(requests[1].toolsChanged).toBe(false);
    expect(requests[2].toolsChanged).toBe(true);
    expect(requests[2].systemChanged).toBe(false);
  });

  it("records the key the pool put on the request, and names the swap when it moves", async () => {
    // The log must sit under `providerFetch`, not above it: the pool is what
    // writes the authorization header, so a wrapper outside it would fingerprint
    // an empty string for exactly the chats a key rotation costs.
    const provider = {
      id: "wire-pool",
      name: "Pooled",
      url: "http://127.0.0.1:1/v1",
      apiKeys: ["sk-one", "sk-two"],
      apiKeyMode: "exhausted" as const,
      models: [],
    };
    const answers = [
      new Response('{"error":{"message":"You exceeded your current quota"}}', { status: 429 }),
      jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    ];
    let at = 0;
    const base = (async () => answers[Math.min(at++, answers.length - 1)]) as typeof globalThis.fetch;
    const call = providerFetch(
      provider,
      withWireLog({ sessionId: "sess-1", providerId: provider.id }, base),
      async () => null,
    );

    const response = await call("https://relay.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(response.status).toBe(200);
    const requests = lines().filter((line) => line.kind === "request");
    // One entry per attempt: the refused key, then the one that paid.
    expect(requests).toHaveLength(2);
    expect(requests[0].key).toHaveLength(8);
    expect(requests[1].key).toHaveLength(8);
    expect(requests[0].keyChanged).toBe(false);
    expect(requests[1].keyChanged).toBe(true);
  });

  it("stays silent when the switch is off", async () => {
    process.env.ACPIO_WIRE_LOG = "0";
    resetWireLogState();
    const fetch = withWireLog(
      { sessionId: "sess-1", providerId: "legacy" },
      (async () => jsonResponse({})) as typeof globalThis.fetch,
    );
    await fetch("https://relay.test/v1/chat/completions", { method: "POST", body: "{}" });
    expect(fs.existsSync(path.join(wireLogDir(), "sess-1.jsonl"))).toBe(false);
  });
});

describe("sharedPrefix", () => {
  it.each([
    [["a", "b"], ["a", "b"], 2],
    [["a", "b"], ["a", "c"], 1],
    [["a"], ["b"], 0],
    [[], ["a"], 0],
    [["a"], [], 0],
  ])("%j vs %j → %i", (a, b, expected) => {
    expect(sharedPrefix(a as string[], b as string[])).toBe(expected);
  });
});
