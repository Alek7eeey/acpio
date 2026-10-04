// Labeled job pool with a wall-clock ceiling per job. A timed-out job is
// aborted through its signal, awaited out, and never recorded: the ceiling
// fires only after the job's promise settles, so a late zombie cannot land
// its value in the ledger or overlap the next run of the label.
const results = new Map();
const active = new Set();

export async function runLabeled(label, job, timeoutMs) {
  active.add(label);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const value = await job(controller.signal);
    if (timedOut) return { ok: false, timedOut: true };
    results.set(label, value);
    return { ok: true, value };
  } finally {
    clearTimeout(timer);
    active.delete(label);
  }
}

export function lastResult(label) {
  return results.get(label);
}

export function activeCount() {
  return active.size;
}
