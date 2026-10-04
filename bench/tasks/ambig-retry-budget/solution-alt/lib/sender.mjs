// sendAll per SPEC-BEHAVIOR.md — alternative policy: 1 retry only, no pause.
// Both policies satisfy the same invariant box; that is the point.

export async function sendAll(transport, items, opts = {}) {
  const sleep = opts.sleep ?? (() => Promise.resolve());
  const delivered = [];
  const failed = [];
  for (const item of items) {
    let ok = false;
    let last;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await sleep(0);
      try {
        await transport.deliver(item.payload);
        ok = true;
        break;
      } catch (err) {
        last = err;
        if (err.retriable === false) break;
      }
    }
    if (ok) delivered.push(item.id);
    else failed.push({ id: item.id, error: last });
  }
  return { delivered, failed };
}
