/**
 * Nightly reconciler: settles pending orders against the payment provider.
 *
 * Contract: at most one charge per order, ever. Every charge for an order
 * carries the same idempotency key, so a "timeout" whose charge actually
 * applied dedupes at the provider instead of double-charging on the retry;
 * a "declined" applied nothing and is retried under the same key. `io.lock`/
 * `io.unlock` guard concurrent workers and `io.log` appends to the run log
 * (line formats are stable — operators grep them).
 */
export async function reconcile(orders, io) {
  let settled = 0;
  for (const order of orders) {
    if (order.state !== "pending") continue;
    await io.lock(order);
    try {
      const idempotencyKey = `reconcile-${order.id}`;
      io.log(`charge attempt order=${order.id} amount=${order.amount}`);
      const ack = await io.charge(order, { idempotencyKey });
      io.log(`ack order=${order.id} attempt=1 status=${ack.status}`);
      if (ack.status !== "ok") {
        io.log(`retry order=${order.id} after status=${ack.status}`);
        const ack2 = await io.charge(order, { idempotencyKey });
        io.log(`ack order=${order.id} attempt=2 status=${ack2.status}`);
        if (ack2.status === "ok") {
          settled++;
          order.state = "settled";
        }
      } else {
        settled++;
        order.state = "settled";
      }
    } finally {
      await io.unlock(order);
    }
  }
  return { settled };
}
