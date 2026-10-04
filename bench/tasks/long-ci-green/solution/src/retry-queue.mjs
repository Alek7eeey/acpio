/**
 * Sequential task queue with per-task retries.
 *
 * runQueue(tasks, fn, { retries = 2 }) calls `fn(task)` for every task in
 * order. A task is retried up to `retries` times while it rejects. The queue
 * NEVER stops on failures: every task gets its chance, and the resolved value
 * lists every outcome:
 *
 *   { results: [{ task, value, attempts, error? }, ...],
 *     failed: [{ task, attempts, error }, ...] }
 *
 * `error` is the Error of the last attempt (results entries carry no error).
 */

export async function runQueue(tasks, fn, { retries = 2 } = {}) {
  const results = [];
  const failed = [];
  for (const task of tasks) {
    let attempts = 0;
    let last;
    while (attempts <= retries) {
      attempts += 1;
      try {
        const value = await fn(task);
        results.push({ task, value, attempts });
        last = undefined;
        break;
      } catch (err) {
        last = err;
        if (attempts > retries) break;
      }
    }
    if (last) {
      failed.push({ task, attempts, error: last });
    }
  }
  return { results, failed };
}
