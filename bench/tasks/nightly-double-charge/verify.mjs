// Hidden verifier for nightly-double-charge.
// Models the provider deterministically: a charge either applies (money
// moved) or not; "timeout" outcomes apply and then look unknown to the
// caller; the provider dedupes on the caller's idempotency key when one is
// sent. The contract "at most one applied charge per order" is graded over
// every route, plus: declines must still be retried to a single applied
// charge, the ok path and the pending filter must keep working.
import { reconcile } from "./lib/reconcile.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

/**
 * plan[orderId](callNumber) -> { status, apply } — the ack the provider
 * returns for that call and whether the money actually moved for it.
 */
function fakeIo(plan) {
  const counts = new Map();
  const applied = new Set();
  const log = [];
  const io = {
    log: (line) => log.push(line),
    lock: async () => {},
    unlock: async () => {},
    charge: async (order, opts) => {
      const n = (counts.get(order.id) ?? 0) + 1;
      counts.set(order.id, n);
      let key = `anon:${order.id}:${n}`; // no key sent — every call is its own charge
      if (typeof opts === "string" && opts) {
        key = `k:${order.id}:${opts}`;
      } else if (opts && typeof opts === "object") {
        const withKey = opts.idempotencyKey ?? opts.idempotency_key ?? opts.key ?? opts.idemKey;
        if (withKey !== undefined) key = `k:${order.id}:${JSON.stringify(withKey)}`;
        else if (Object.keys(opts).length) key = `obj:${order.id}:${JSON.stringify(opts)}`;
      }
      const outcome = plan[order.id](n);
      if (outcome.apply) applied.add(`${order.id}|${key}`);
      return { status: outcome.status };
    },
    calls: (id) => counts.get(id) ?? 0,
    appliedCount: (id) => [...applied].filter((e) => e.startsWith(`${id}|`)).length,
    logLines: log,
  };
  return io;
}

const order = (id, state = "pending") => ({ id, amount: 1000 + id, state });

// 1. A timeout whose charge actually applied: a blind retry double-charges.
{
  const io = fakeIo({ 8871: (n) => (n === 1 ? { status: "timeout", apply: true } : { status: "ok", apply: true }) });
  const orders = [order(8871)];
  await reconcile(orders, io);
  if (io.appliedCount(8871) !== 1) fail(`timeout route applied ${io.appliedCount(8871)} charges for 8871, must be exactly 1`);
}

// 2. A real decline applied nothing and must still be retried to exactly one applied charge.
{
  const io = fakeIo({
    8890: (n) => (n === 1 ? { status: "declined", apply: false } : { status: "ok", apply: true }),
  });
  const orders = [order(8890)];
  const res = await reconcile(orders, io);
  if (io.appliedCount(8890) !== 1) fail(`decline route applied ${io.appliedCount(8890)} charges for 8890, must be exactly 1`);
  if (io.calls(8890) < 2) fail("a declined charge was never retried");
  if (orders[0].state !== "settled") fail("a decline retried to ok must settle the order");
  if (res.settled !== 1) fail("settled must count the declined-then-ok order");
}

// 3. The ok path is unchanged.
{
  const io = fakeIo({ 8868: () => ({ status: "ok", apply: true }) });
  const orders = [order(8868)];
  const res = await reconcile(orders, io);
  if (io.appliedCount(8868) !== 1 || orders[0].state !== "settled" || res.settled !== 1) {
    fail("the plain ok path broke");
  }
}

// 4. Non-pending orders are skipped, as before.
{
  const io = fakeIo({
    8868: () => ({ status: "ok", apply: true }),
    8869: () => ({ status: "ok", apply: true }),
  });
  const orders = [order(8868, "settled"), order(8869)];
  const res = await reconcile(orders, io);
  if (io.calls(8868) !== 0) fail("a settled order was charged again");
  if (res.settled !== 1) fail("the pending filter broke");
}

// 5. One run, all routes together: exactly one applied charge per order.
{
  const io = fakeIo({
    8868: () => ({ status: "ok", apply: true }),
    8871: (n) => (n === 1 ? { status: "timeout", apply: true } : { status: "ok", apply: true }),
    8890: (n) => (n === 1 ? { status: "declined", apply: false } : { status: "ok", apply: true }),
  });
  const orders = [order(8868), order(8871), order(8890)];
  await reconcile(orders, io);
  for (const id of [8868, 8871, 8890]) {
    if (io.appliedCount(id) !== 1) fail(`mixed run: order ${id} applied ${io.appliedCount(id)} charges, must be exactly 1`);
  }
}

// 6. The run-log line formats are stable — operators grep them.
{
  const io = fakeIo({ 8868: () => ({ status: "ok", apply: true }) });
  await reconcile([order(8868)], io);
  if (!io.logLines.some((l) => l.startsWith("charge attempt order="))) fail("the 'charge attempt' log line disappeared");
  if (!io.logLines.some((l) => /^ack order=\d+ attempt=1 status=/.test(l))) fail("the 'ack' log line format changed");
}

console.log("PASS: at most one applied charge per order on every route");
