import test from "node:test";
import assert from "node:assert/strict";
import { createClient, ApiError, resolveConfig, delayForAttempt } from "../src/index.mjs";

const okFetch = (body = { ok: true }) => async () => ({ status: 200, text: async () => JSON.stringify(body) });
const quietSleep = async () => {};

test("get resolves {status, data} on the first attempt", async () => {
  let calls = 0;
  const client = createClient({ fetchImpl: async () => { calls += 1; return { status: 200, text: async () => '{"n":5}' }; }, sleep: quietSleep });
  assert.deepEqual(await client.get("/x"), { status: 200, data: { n: 5 } });
  assert.equal(calls, 1);
});

test("empty response body parses to null", async () => {
  const client = createClient({ fetchImpl: async () => ({ status: 204, text: async () => "" }), sleep: quietSleep });
  assert.deepEqual(await client.get("/x"), { status: 204, data: null });
});

test("post sends JSON body and content-type", async () => {
  const seen = [];
  const client = createClient({ fetchImpl: async (url, init) => { seen.push([url, init]); return { status: 201, text: async () => "" }; }, sleep: quietSleep });
  await client.post("/items", { a: 1 });
  assert.equal(seen[0][0], "/items");
  assert.equal(seen[0][1].method, "POST");
  assert.equal(seen[0][1].headers["content-type"], "application/json");
  assert.equal(seen[0][1].body, '{"a":1}');
});

test("GET requests carry no content-type header", async () => {
  const seen = [];
  const client = createClient({ fetchImpl: async (url, init) => { seen.push(init); return { status: 200, text: async () => "" }; }, sleep: quietSleep });
  await client.get("/x");
  assert.equal(seen[0].headers, undefined);
});

test("5xx is retried with the backoff schedule, then succeeds", async () => {
  const sleeps = [];
  let n = 0;
  const client = createClient({
    retries: 3,
    fetchImpl: async () => {
      n += 1;
      if (n < 3) return { status: 503, text: async () => "" };
      return { status: 200, text: async () => '{"fine":true}' };
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(await client.get("/x"), { status: 200, data: { fine: true } });
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [delayForAttempt(1), delayForAttempt(2)]);
});

test("exhaustion throws ApiError with attempts and cause", async () => {
  let n = 0;
  const client = createClient({
    retries: 2,
    fetchImpl: async () => { n += 1; throw new Error("socket down"); },
    sleep: quietSleep,
  });
  await assert.rejects(client.get("/x"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.attempts, 3);
    assert.equal(n, 3);
    assert.match(err.message, /^exhausted after 3 attempts/);
    assert.equal(err.cause.message, "socket down");
    return true;
  });
});

test("4xx fails fast without retries", async () => {
  let calls = 0;
  const client = createClient({
    retries: 5,
    fetchImpl: async () => { calls += 1; return { status: 404, text: async () => "" }; },
    sleep: quietSleep,
  });
  await assert.rejects(client.get("/x"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(calls, 1);
});

test("baseUrl is prefixed to the path", async () => {
  const seen = [];
  const client = createClient({ baseUrl: "https://api.example.com", fetchImpl: async (url) => { seen.push(url); return { status: 200, text: async () => "" }; }, sleep: quietSleep });
  await client.get("/v1/things");
  assert.equal(seen[0], "https://api.example.com/v1/things");
});

test("resolveConfig validates", () => {
  assert.throws(() => resolveConfig({ retries: 6 }), RangeError);
  assert.throws(() => resolveConfig({ retries: -1 }), RangeError);
  assert.throws(() => resolveConfig({ baseUrl: "http://api.example.com" }), TypeError);
  const cfg = resolveConfig({});
  assert.equal(cfg.retries, 2);
  assert.equal(cfg.baseUrl, "");
});

test("delayForAttempt repeats the last table value", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(delayForAttempt), [0, 50, 200, 200, 200]);
  assert.throws(() => delayForAttempt(0), RangeError);
});
