// sendAll per SPEC-BEHAVIOR.md. Policy (documented in the repo's
// ASSUMPTIONS.md at task time): 3 retries per item, 250ms fixed pause between
// attempts via opts.sleep, everything sequential — "a few, never hammer".

export async function sendAll(transport, items, opts = {}) {
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delivered = [];
  const failed = [];
  for (const item of items) {
    let attempts = 0;
    let last;
    while (attempts < 4) {
      if (attempts > 0) await sleep(250);
      attempts += 1;
      try {
        await transport.deliver(item.payload);
        delivered.push(item.id);
        last = null;
        break;
      } catch (err) {
        last = err;
        if (err.retriable === false) break;
      }
    }
    if (last && attempts >= 4 && last.retriable !== false) {
      failed.push({ id: item.id, error: last });
    } else if (last && last.retriable === false) {
      failed.push({ id: item.id, error: last });
    }
  }
  return { delivered, failed };
}
