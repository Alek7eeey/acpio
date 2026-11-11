import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinProviderConfig } from "@acpio/shared";
import {
  nextProviderKey,
  providerFetch,
  resetProviderKeyCursors,
  type KeySpendProbe,
} from "./keys.js";

const provider = (over: Partial<BuiltinProviderConfig> = {}): BuiltinProviderConfig => ({
  id: "p1",
  name: "Pooled",
  url: "http://127.0.0.1:1/v1",
  apiKeys: ["sk-one", "sk-two"],
  models: [],
  ...over,
});

/** Every request the wrapper made: the key it carried, in order. */
function recorder(responses: Array<Response | (() => Response)>) {
  const seen: string[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const next = responses[Math.min(seen.length - 1, responses.length - 1)];
    return typeof next === "function" ? next() : next;
  });
  return { seen, fetchMock: fetchMock as unknown as typeof fetch, calls: fetchMock };
}

const ok = () => new Response("{}", { status: 200 });
const quota = () =>
  new Response('{"error":{"message":"You exceeded your current quota"}}', { status: 429 });

/** A vendor's answer per key: percent spent, or `null` for "reports no quota". */
function spendTable(table: Record<string, number | null>): KeySpendProbe {
  return async (_provider, apiKey) => table[apiKey] ?? null;
}

beforeEach(() => resetProviderKeyCursors());

describe("providerFetch", () => {
  it("rotates the key on every request by default", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider(), fetchMock);
    await call("http://x/v1/chat/completions", { method: "POST" });
    await call("http://x/v1/chat/completions", { method: "POST" });
    await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two", "Bearer sk-one"]);
  });

  it("keeps one key in exhausted mode until it is refused", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider({ apiKeyMode: "exhausted" }), fetchMock);
    for (let i = 0; i < 3; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-one", "Bearer sk-one"]);
  });

  it("resends the request on the next key when one is out of quota", async () => {
    const responses = [quota, ok];
    const { seen, fetchMock } = recorder(responses);
    const call = providerFetch(provider({ apiKeyMode: "exhausted" }), fetchMock);
    const first = await call("http://x/v1/chat/completions", { method: "POST" });
    expect(first.status).toBe(200);
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
    // The spent key is skipped for good, not just for that one request.
    await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen[2]).toBe("Bearer sk-two");
  });

  it("retries on the next key in rotate mode too", async () => {
    const { seen, fetchMock } = recorder([quota, ok]);
    const call = providerFetch(provider(), fetchMock);
    const res = await call("http://x/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
  });

  it("gives up on the endpoint's own response once every key is spent", async () => {
    const { seen, fetchMock, calls } = recorder([quota]);
    const call = providerFetch(provider(), fetchMock);
    const res = await call("http://x/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(429);
    // One attempt per key, no loop.
    expect(calls).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
  });

  it("treats a quota in the body as a spent key, a plain 400 as the request's fault", async () => {
    const quotaBody = new Response(
      '{"error":{"code":"insufficient_quota","message":"no funds"}}',
      { status: 400 },
    );
    const plain = new Response('{"error":{"message":"bad temperature"}}', { status: 400 });
    const { seen, fetchMock } = recorder([quotaBody, ok, plain, plain]);
    const call = providerFetch(provider(), fetchMock);
    expect((await call("http://x/v1/chat/completions", {})).status).toBe(200);
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
    // A 400 that says nothing about money answers the caller as it came — on
    // the key that still serves, since the refused one is out of the pool.
    expect((await call("http://x/v1/chat/completions", {})).status).toBe(400);
    expect(seen[2]).toBe("Bearer sk-two");
  });

  it("counts revoked and unpaid keys as spent", async () => {
    for (const status of [401, 402, 403, 429]) {
      resetProviderKeyCursors();
      const { seen, fetchMock } = recorder([new Response("{}", { status }), ok]);
      const call = providerFetch(provider({ apiKeyMode: "exhausted" }), fetchMock);
      expect((await call("http://x/v1/chat/completions", {})).status).toBe(200);
      expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
    }
  });

  it("does not resend a request body that cannot be repeated", async () => {
    const { seen, fetchMock, calls } = recorder([quota]);
    const call = providerFetch(provider(), fetchMock);
    const body = new ReadableStream();
    const res = await call("http://x/v1/chat/completions", {
      method: "POST",
      body,
      // A stream body needs a duplex option to be a legal fetch body at all.
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(429);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["Bearer sk-one"]);
  });

  it("leaves the request alone when the provider sets its own Authorization", async () => {
    const base = vi.fn(async () => ok());
    const call = providerFetch(
      provider({ headers: [{ name: "Authorization", value: "Bearer own" }] }),
      base as unknown as typeof fetch,
    );
    await call("http://x/v1/chat/completions", {});
    expect(base).toHaveBeenCalledTimes(1);
    expect((base.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers).toBeUndefined();
  });

  it("leaves a keyless provider alone", async () => {
    const base = vi.fn(async () => ok());
    const call = providerFetch(provider({ apiKeys: [] }), base as unknown as typeof fetch);
    await call("http://x/v1/chat/completions", {});
    expect(base).toHaveBeenCalledTimes(1);
  });
});

describe("providerFetch with what the vendor reports", () => {
  it("balances every request onto the least spent key in smart mode", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, spendTable({
      "sk-one": 90,
      "sk-two": 10,
    }));
    for (let i = 0; i < 3; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer sk-two", "Bearer sk-two", "Bearer sk-two"]);
  });

  it("never sends a request to a key the vendor calls spent", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider(), fetchMock, spendTable({ "sk-one": 100, "sk-two": 20 }));
    for (let i = 0; i < 3; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    // Rotate order would take sk-one first; a 100 % key is stepped over instead.
    expect(seen).toEqual(["Bearer sk-two", "Bearer sk-two", "Bearer sk-two"]);
  });

  it("falls back to the rotation when the vendor reports no quota", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const unknowns = vi.fn(async () => null);
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, unknowns);
    for (let i = 0; i < 3; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    // A wallet, an unknown vendor, a failed read: nothing to compare, so the
    // pool still spreads instead of pinning one key.
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two", "Bearer sk-one"]);
  });

  it("reads a key once per minute, not once per request", async () => {
    const { fetchMock } = recorder([ok]);
    const probe = vi.fn(spendTable({ "sk-one": 10, "sk-two": 20 }));
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, probe);
    for (let i = 0; i < 3; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps a refused key out of the pool while another one is left", async () => {
    const { seen, fetchMock, calls } = recorder([quota, ok]);
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, spendTable({}));
    expect((await call("http://x/v1/chat/completions", {})).status).toBe(200);
    expect(seen).toEqual(["Bearer sk-one", "Bearer sk-two"]);
    // sk-one is out of the pool for a while now, so the next request goes
    // straight to sk-two instead of knocking and retrying again.
    calls.mockClear();
    await call("http://x/v1/chat/completions", {});
    expect(calls).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe("Bearer sk-two");
  });

  it("still asks the endpoint when every key is out — its answer, not ours", async () => {
    const { fetchMock, calls } = recorder([quota]);
    const call = providerFetch(provider(), fetchMock, spendTable({ "sk-one": 100, "sk-two": 100 }));
    expect((await call("http://x/v1/chat/completions", {})).status).toBe(429);
    expect(calls).toHaveBeenCalledTimes(2);
  });
});

describe("nextProviderKey", () => {
  it("consumes keys in rotate mode and hands out one in exhausted mode", () => {
    const rotating = provider();
    expect(nextProviderKey(rotating)).toBe("sk-one");
    expect(nextProviderKey(rotating)).toBe("sk-two");
    expect(nextProviderKey(rotating)).toBe("sk-one");

    resetProviderKeyCursors();
    const sticky = provider({ apiKeyMode: "exhausted" });
    expect(nextProviderKey(sticky)).toBe("sk-one");
    expect(nextProviderKey(sticky)).toBe("sk-one");
  });

  it("hands out the least spent key in smart mode, once it is known", async () => {
    const { fetchMock } = recorder([ok]);
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, spendTable({
      "sk-one": 80,
      "sk-two": 5,
    }));
    await call("http://x/v1/chat/completions", {});
    // The reading the request took is what a title call picks its key from.
    expect(nextProviderKey(provider({ apiKeyMode: "smart" }))).toBe("sk-two");
  });

  it("reads a legacy single key and comes back empty without any", () => {
    expect(nextProviderKey(provider({ apiKeys: [], apiKey: "sk-old" }))).toBe("sk-old");
    expect(nextProviderKey(provider({ apiKeys: [] }))).toBe("");
  });
});

describe("a chat keeps its key", () => {
  it("holds one key for the whole conversation in rotate mode", async () => {
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider({ apiKeyMode: "rotate" }), fetchMock, undefined, "s-1");
    for (let i = 0; i < 4; i++) await call("http://x/v1/chat/completions", { method: "POST" });
    expect(new Set(seen).size).toBe(1);
  });

  it("spreads different chats over different keys", async () => {
    const { seen, fetchMock } = recorder([ok]);
    for (let i = 0; i < 8; i++) {
      const call = providerFetch(provider({ apiKeyMode: "rotate" }), fetchMock, undefined, `chat-${i}`);
      await call("http://x/v1/chat/completions", { method: "POST" });
    }
    expect(new Set(seen)).toEqual(new Set(["Bearer sk-one", "Bearer sk-two"]));
  });

  it("starts a smart chat on the least spent key and stays there", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let table: Record<string, number | null> = { "sk-one": 90, "sk-two": 10 };
    const probe: KeySpendProbe = async (_provider, apiKey) => table[apiKey] ?? null;
    const { seen, fetchMock } = recorder([ok]);
    const call = providerFetch(provider({ apiKeyMode: "smart" }), fetchMock, probe, "s-1");

    await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer sk-two"]);

    // The quota moves every turn; the cached prefix does not. The chat stays.
    table = { "sk-one": 5, "sk-two": 40 };
    now += 61_000;
    await call("http://x/v1/chat/completions", { method: "POST" });
    expect(seen).toEqual(["Bearer sk-two", "Bearer sk-two"]);
  });

  it("re-picks a key for the chat when the held one runs out", async () => {
    const { seen, fetchMock } = recorder([quota(), ok, ok]);
    const call = providerFetch(provider({ apiKeyMode: "rotate" }), fetchMock, undefined, "s-1");
    await call("http://x/v1/chat/completions", { method: "POST" });
    await call("http://x/v1/chat/completions", { method: "POST" });
    // The refused key is gone from the pool, so the retry and the next turn both
    // land on the other one — one miss, then the chat warms the new key.
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[2]).toBe(seen[1]);
  });
});
