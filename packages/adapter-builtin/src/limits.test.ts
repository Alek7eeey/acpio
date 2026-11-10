// Limits fetcher: real HTTP against a local server, so the URL each kind asks,
// the auth header and the payload shapes are exercised end to end. The pool in
// `keys.ts` reads the same answer to decide which key a request may use.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { builtinKeySpentPercent, fetchBuiltinProviderLimits } from "./limits.js";
import type { BuiltinLimitMeter } from "@acpio/shared";

function portOf(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server is not listening on a TCP port");
  return addr.port;
}

/** Header the fixture switches its answer on — one route, many answers. */
const CASE = "x-test-case";

let server: http.Server;
let base = "";
/** Port that was listening once and is closed afterwards (connection refused). */
let closedPort = 0;
/** Paths the fixture was asked for, in order — proves which URL a kind uses. */
let seen: Array<{ path: string; auth: string; header: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const kase = String(req.headers[CASE] ?? "");
    seen.push({
      path: url,
      auth: req.headers.authorization ?? "",
      header: String(req.headers["x-opencode-session"] ?? ""),
    });
    const json = (payload: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    // OpenCode Zen: the metered subscription windows, on the go/ base and on
    // the sibling of the inference base (the two shapes the CLI and the app use).
    if (url === "/zen/go/v1/usage" || url === "/inference/go/v1/usage") {
      json({
        usage: {
          rolling: { status: "ok", percent: 1, resetsAt: "2026-11-07T16:54:11.000Z" },
          weekly: { status: "ok", percent: 15.44, resetsAt: "2026-11-09T00:00:00.000Z" },
          monthly: { status: "exhausted", percent: 100 },
          junk: "not a bucket",
        },
      });
      return;
    }
    // DeepSeek: the wallet.
    if (url === "/user/balance") {
      json({
        is_available: true,
        balance_infos: [
          { currency: "cny", total_balance: "110.00", granted_balance: "10.00" },
          { currency: "usd", total_balance: "0" },
        ],
      });
      return;
    }
    // OpenRouter: the key's own budget, and the broken answers of this file.
    if (url === "/api/v1/key") {
      if (kase === "401") {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      if (kase === "html") {
        res.setHeader("content-type", "text/html");
        res.end("<html>nope</html>");
        return;
      }
      if (kase === "shapeless") {
        json({ hello: "world" });
        return;
      }
      json({
        data: {
          label: "sk-or",
          usage: 5.5,
          // An unlimited key reports no limit at all.
          limit: kase === "no-limit" ? null : 20,
          limit_remaining: kase === "no-limit" ? null : 14.5,
        },
      });
      return;
    }
    // Moonshot: one available balance.
    if (url === "/v1/users/me/balance") {
      json({ code: 0, data: { available_balance: 42.5, voucher_balance: 0 } });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(server)}`;

  const throwaway = http.createServer();
  await new Promise<void>((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
  closedPort = portOf(throwaway);
  await new Promise<void>((resolve) => throwaway.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const withCase = (value: string) => ({ headers: [{ name: CASE, value }] });

describe("fetchBuiltinProviderLimits", () => {
  it("reads the OpenCode Zen windows, keeping percents, status and resets", async () => {
    seen = [];
    const result = await fetchBuiltinProviderLimits(`${base}/zen/go/v1`, "oc_sk-1", "opencode");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("opencode");
    expect(result.meters).toEqual([
      { key: "rolling", percent: 1, resetsAt: "2026-11-07T16:54:11.000Z", status: "ok" },
      { key: "weekly", percent: 15.4, resetsAt: "2026-11-09T00:00:00.000Z", status: "ok" },
      // A 100 % bucket is spent; the payload's non-bucket rows are ignored.
      { key: "monthly", percent: 100, status: "exhausted" },
    ]);
    expect(Date.parse(result.fetchedAt)).not.toBeNaN();
    expect(seen.map((s) => s.path)).toEqual(["/zen/go/v1/usage"]);
    expect(seen[0]?.auth).toBe("Bearer oc_sk-1");
  });

  it("moves on to the go/ base when the plain Zen base has no /usage", async () => {
    seen = [];
    const result = await fetchBuiltinProviderLimits(`${base}/zen/v1`, "oc_sk-2", "opencode");
    expect(result.ok).toBe(true);
    // The plain base answers 404, which is what sends it to the sibling.
    expect(seen.map((s) => s.path)).toEqual(["/zen/v1/usage", "/zen/go/v1/usage"]);
  });

  // The base the OpenCode CLI talks to nests an extra openai/ segment, and its
  // /usage lives on the sibling /v1 — the same rule its model list follows.
  it("reads the limits of the inference base the OpenCode CLI uses", async () => {
    seen = [];
    const result = await fetchBuiltinProviderLimits(
      `${base}/inference/go/openai/v1`,
      "oc_sk-4",
      "opencode",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meters.map((m) => m.key)).toEqual(["rolling", "weekly", "monthly"]);
    expect(seen.map((s) => s.path)).toEqual([
      "/inference/go/openai/v1/usage",
      "/inference/go/v1/usage",
    ]);
  });

  // "No such route" anywhere and "wrong key" are different answers: one says
  // the URL is not a limits API, the other sends the user to the key.
  it("says the address has no limits API when every candidate is a 404", async () => {
    const result = await fetchBuiltinProviderLimits(`${base}/nowhere/v1`, "oc_sk-5", "opencode");
    expect(result).toEqual({ ok: false, code: "notFound", detail: `${base}/nowhere/v1/usage` });
    expect(await fetchBuiltinProviderLimits(`${base}/api/v1`, "sk", "openrouter", withCase("401")))
      .toEqual({ ok: false, code: "httpStatus", detail: "401" });
  });

  it("reads the DeepSeek wallet, one row per currency", async () => {
    const result = await fetchBuiltinProviderLimits(`${base}/v1`, "sk-ds", "deepseek");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meters).toEqual([
      { key: "balance", amount: 110, unit: "CNY" },
      // A numeric string "0" is a real amount, not a missing one.
      { key: "balance", amount: 0, unit: "USD" },
    ]);
  });

  it("reads the OpenRouter key budget as spent out of the whole", async () => {
    const limited = await fetchBuiltinProviderLimits(`${base}/api/v1`, "sk-or", "openrouter");
    expect(limited.ok).toBe(true);
    if (!limited.ok) return;
    expect(limited.meters).toEqual([{ key: "credits", used: 5.5, total: 20, unit: "USD" }]);

    // An unlimited key has nothing to fill a bar with: the spend alone is the row.
    const unlimited = await fetchBuiltinProviderLimits(
      `${base}/api/v1`,
      "sk-or",
      "openrouter",
      withCase("no-limit"),
    );
    expect(unlimited.ok).toBe(true);
    if (!unlimited.ok) return;
    expect(unlimited.meters).toEqual([{ key: "credits", amount: 5.5, unit: "USD" }]);
  });

  it("reads the Moonshot balance", async () => {
    const result = await fetchBuiltinProviderLimits(`${base}/v1`, "sk-ms", "moonshot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meters).toEqual([{ key: "balance", amount: 42.5 }]);
  });

  it("sends the provider's own headers along", async () => {
    seen = [];
    await fetchBuiltinProviderLimits(`${base}/zen/go/v1`, "oc_sk-3", "opencode", {
      headers: [{ name: "x-opencode-session", value: "chat-42" }],
    });
    expect(seen[0]?.header).toBe("chat-42");
  });

  it("refuses an endpoint of an unknown kind without asking anyone", async () => {
    seen = [];
    expect(await fetchBuiltinProviderLimits(`${base}/v1`, "sk-1", "other")).toEqual({
      ok: false,
      code: "unsupported",
    });
    // A kind that was never known is the same thing as "other".
    expect(await fetchBuiltinProviderLimits(`${base}/v1`, "sk-1", "nonsense")).toEqual({
      ok: false,
      code: "unsupported",
    });
    expect(seen).toEqual([]);
  });

  it("says what is missing before reaching the network", async () => {
    seen = [];
    expect(await fetchBuiltinProviderLimits("  ", "sk-1", "deepseek")).toEqual({
      ok: false,
      code: "noEndpoint",
    });
    expect(await fetchBuiltinProviderLimits(`${base}/v1`, "  ", "deepseek")).toEqual({
      ok: false,
      code: "noKey",
    });
    expect(await fetchBuiltinProviderLimits("ftp://x/v1", "sk-1", "deepseek")).toEqual({
      ok: false,
      code: "badUrl",
      detail: "ftp://x/v1",
    });
    expect(seen).toEqual([]);
  });

  it("reports an auth error with its status instead of retrying", async () => {
    seen = [];
    const result = await fetchBuiltinProviderLimits(
      `${base}/api/v1`,
      "sk-1",
      "openrouter",
      withCase("401"),
    );
    expect(result).toEqual({ ok: false, code: "httpStatus", detail: "401" });
    // An auth error is the same on every candidate: one call, then done.
    expect(seen).toHaveLength(1);
  });

  it("maps a dead endpoint, an HTML answer and a shapeless payload", async () => {
    expect(
      await fetchBuiltinProviderLimits(`http://127.0.0.1:${closedPort}/v1`, "k", "deepseek"),
    ).toMatchObject({ ok: false, code: "unreachable" });
    expect(
      await fetchBuiltinProviderLimits(`${base}/api/v1`, "k", "openrouter", withCase("html")),
    ).toEqual({ ok: false, code: "notJson" });
    expect(
      await fetchBuiltinProviderLimits(
        `${base}/api/v1`,
        "k",
        "openrouter",
        withCase("shapeless"),
      ),
    ).toEqual({ ok: false, code: "unexpected" });
  });
});

describe("builtinKeySpentPercent", () => {
  it("takes the worst bucket the vendor reports", () => {
    expect(builtinKeySpentPercent([{ key: "rolling", percent: 1 }, { key: "monthly", percent: 100 }])).toBe(100);
    expect(builtinKeySpentPercent([{ key: "credits", used: 5.5, total: 20 }])).toBe(27.5);
    // An over-spent wallet is still just done, not 130 %.
    expect(builtinKeySpentPercent([{ key: "credits", used: 26, total: 20 }])).toBe(100);
  });

  it("says nothing when the vendor reports no quota", () => {
    // A wallet balance is not a share: `null` leaves the pool in rotation order.
    const meters: BuiltinLimitMeter[] = [{ key: "balance", amount: 110, unit: "CNY" }];
    expect(builtinKeySpentPercent(meters)).toBeNull();
    expect(builtinKeySpentPercent([])).toBeNull();
  });
});
