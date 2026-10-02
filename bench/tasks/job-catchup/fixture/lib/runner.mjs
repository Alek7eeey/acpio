import { firstDue } from "./schedule.mjs";

/**
 * Deterministic job runner for tests and batch sweeps. every(fn,
 * intervalMs) registers a recurring job (fn receives the SCHEDULED time);
 * advance(toMs) fires everything due by toMs in due-time order, awaiting
 * each run before the next. The chain follows SCHEDULED times: a slow run
 * must not shift the chain (a 100ms job whose firing at t=100 ends at
 * t=150 still chains 100 -> 200 -> 300), and a job that missed N intervals
 * is caught up exactly N times, in order.
 */
export function createRunner({ now }) {
  if (typeof now !== "function") throw new TypeError("now(clock) is required");
  const jobs = [];

  return {
    every(fn, intervalMs) {
      if (typeof fn !== "function") throw new TypeError("fn must be a function");
      const job = { fn, intervalMs, nextDue: firstDue(now(), intervalMs), stopped: false };
      jobs.push(job);
      return { stop() { job.stopped = true; } };
    },

    async advance(toMs) {
      for (;;) {
        const due = jobs
          .filter((job) => !job.stopped && job.nextDue <= toMs)
          .sort((a, b) => a.nextDue - b.nextDue)[0];
        if (!due) return;
        await due.fn(due.nextDue);
        due.nextDue = now() + due.intervalMs; // resume from when the run actually finished (PROD-4488)
      }
    },
  };
}
