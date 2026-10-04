// Hidden verifier for priv-timeout-cancel.
// Contract: a timed-out job is aborted through its AbortSignal, its late
// result never lands in the ledger, the label stays free for the next job,
// and the pool does not report active work while the zombie winds down.
import { setTimeout as delay } from "node:timers/promises";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const { runLabeled, lastResult, activeCount } = await import("./lib/pool.mjs");

// A zombie: ignores its signal for 80ms, then tries to publish anyway.
let zombieAborted = false;
let latePublishAttempted = false;
const zombieJob = (signal) =>
  new Promise((resolve) => {
    signal?.addEventListener("abort", () => {
      zombieAborted = true;
    });
    setTimeout(() => {
      latePublishAttempted = true;
      resolve({ zombie: true });
    }, 80);
  });

const first = await runLabeled("slot-1", zombieJob, 20);
if (!(!first.ok && first.timedOut)) fail(`timed-out run must report { ok:false, timedOut:true }, got ${JSON.stringify(first)}`);
if (lastResult("slot-1") !== undefined) fail("a timed-out job must not be recorded under its own label");
if (!zombieAborted) fail("the job never received an abort when the ceiling fired");
if (activeCount() !== 0) fail(`pool reports ${activeCount()} active job(s) while the zombie winds down`);

// The label is reused while the zombie is still winding down: the next job's
// result must be the one that sticks.
const second = await runLabeled("slot-1", async () => {
  await delay(10);
  return { job: "second" };
}, 1_000);
if (!second.ok) fail("the next job on the same label timed out unexpectedly");
if (lastResult("slot-1")?.job !== "second") fail(`ledger holds ${JSON.stringify(lastResult("slot-1"))} instead of the second job's value`);

await delay(100); // let the zombie's timer fire
if (!latePublishAttempted) fail("test setup: the zombie never tried to publish late");
if (lastResult("slot-1")?.job !== "second") fail("the zombie's late result overwrote the second job");

console.log("PASS: timed-out jobs are aborted, never recorded, labels stay clean");
