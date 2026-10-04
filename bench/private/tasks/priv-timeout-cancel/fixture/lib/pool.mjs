// Labeled job pool with a wall-clock ceiling per job.
import { randomUUID } from "node:crypto";

const results = new Map();
const active = new Set();

/**
 * Run `job(signal)` under `label`. Resolves
 *   { ok: true, value }            — the job finished in time, or
 *   { ok: false, timedOut: true }  — the ceiling fired.
 * `results` maps label -> last recorded value; `activeCount()` reports how
 * many jobs are still running.
 */
export async function runLabeled(label, job, timeoutMs) {
  active.add(label);
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
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
