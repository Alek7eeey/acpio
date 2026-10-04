// Hidden verifier for ambig-retry-budget. The ticket leaves the exact policy
// open, so this is a property check, not a trace check: ANY retry policy that
// satisfies the invariants below passes (transient errors retried 1..4 extra
// times, no hammering cap of 5 deliver calls per item, permanent errors on
// the first attempt, independence of items, delivery exactly once).
import { existsSync, readFileSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync("ASSUMPTIONS.md")) fail("ASSUMPTIONS.md is missing — the budget is a decision, write it down");
if (!readFileSync("ASSUMPTIONS.md", "utf8").trim()) fail("ASSUMPTIONS.md is empty");

const { sendAll } = await import("./lib/sender.mjs");
if (typeof sendAll !== "function") fail("lib/sender.mjs must export sendAll(transport, items, opts)");

const MAX_CALLS_PER_ITEM = 5;

/** Scripted transport: per-item behavior list, every call recorded. */
function makeTransport(script) {
  const calls = [];
  const counts = {};
  return {
    calls,
    deliver: async (payload) => {
      calls.push(payload);
      counts[payload] = (counts[payload] ?? 0) + 1;
      if (counts[payload] > MAX_CALLS_PER_ITEM) {
        const err = new Error(`hammering: ${payload} delivered ${counts[payload]} times`);
        err.retriable = false;
        throw err;
      }
      const step = script(payload, counts[payload]);
      if (step === "ok") return { ok: true };
      const err = new Error(step);
      err.retriable = step !== "permanent";
      throw err;
    },
  };
}

const opts = { sleep: async () => {} };
let scenarios = 0;
const eq = (got, want, label) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${label}: got ${a?.slice(0, 300)}, want ${b}`);
  scenarios += 1;
};

// 1. clean run: every item delivered exactly once
{
  const t = makeTransport(() => "ok");
  const out = await sendAll(t, [{ id: "a", payload: "a" }, { id: "b", payload: "b" }], opts);
  eq(out.delivered.sort(), ["a", "b"], "clean run delivered");
  eq(out.failed, [], "clean run failed");
  eq(t.calls.sort().join(""), "ab", "clean run: one call per item");
}

// 2. transient twice then success: retried, delivered, within the cap
{
  const t = makeTransport((id, n) => (n < 2 ? "transient" : "ok"));
  const out = await sendAll(t, [{ id: "t1", payload: "t1" }], opts);
  eq(out.delivered, ["t1"], "transient recovered");
  eq(out.failed, [], "transient failed empty");
  if ((t.calls.filter((c) => c === "t1").length) < 2) fail("transient error was never retried — the ticket says it may be resent");
  scenarios += 1;
}

// 3. permanent error: exactly one attempt, lands in failed
{
  const t = makeTransport(() => "permanent");
  const out = await sendAll(t, [{ id: "p1", payload: "p1" }], opts);
  eq(out.delivered, [], "permanent delivered empty");
  eq(out.failed.map((f) => f.id), ["p1"], "permanent failed entry");
  eq(t.calls.length, 1, "permanent retried despite being fatal");
}

// 4. one exhausting item does not stop the others
{
  const t = makeTransport((id) => (id === "dead" ? "transient" : "ok"));
  const out = await sendAll(t, [{ id: "alive1", payload: "alive1" }, { id: "dead", payload: "dead" }, { id: "alive2", payload: "alive2" }], opts);
  eq(out.delivered.sort(), ["alive1", "alive2"], "others delivered around a dead item");
  eq(out.failed.map((f) => f.id), ["dead"], "dead item in failed");
  const deadCalls = t.calls.filter((c) => c === "dead").length;
  if (deadCalls < 2 || deadCalls > MAX_CALLS_PER_ITEM) fail(`dead item called ${deadCalls} times — expected a bounded retry, 2..${MAX_CALLS_PER_ITEM}`);
  scenarios += 1;
}

// 5. last error surfaces in failed
{
  const t = makeTransport((id, n) => `boom-${n}`);
  const out = await sendAll(t, [{ id: "e1", payload: "e1" }], opts);
  if (!/boom-\d+$/.test(String(out.failed[0]?.error?.message ?? out.failed[0]?.error ?? ""))) {
    fail(`failed[0].error should carry the last error message, got ${JSON.stringify(out.failed)}`);
  }
  scenarios += 1;
}

console.log(`PASS: every scenario holds inside the invariant box (${scenarios} scenarios, cap ${MAX_CALLS_PER_ITEM} calls/item)`);
