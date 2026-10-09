#!/usr/bin/env node
// Frozen baseline: the BEST passing run per agent/task across every recorded
// bench stamp. pi and omp do not change between iterations, so their reference
// numbers should be their best observed run, not whichever run happened next to
// the latest builtin attempt — single repeats swing ±1-2 tools and ±200 tokens
// per task, and comparing live runs lets that noise pick the winner.
//
// Token numbers come from each stamp's .calls.jsonl (the wire), rows come from
// <stamp>.jsonl. Runs with known task defects are excluded via BASELINE_SKIP.
//
//   node bench/baseline.mjs            # print the baseline table (all models)
//   node bench/baseline.mjs --model local-model   # one model's table only
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

const modelArg = (() => {
  const i = process.argv.indexOf("--model");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// Task/stamp combinations where the task itself was different (broken fixture)
// or the run is known-contaminated (builtin zombie), so they must not feed the
// reference. Keyed `<stamp>:<agent>/<task>`; `*:agent/task` skips every stamp.
const SKIP = new Set([
  // debug-suite ran on an empty workspace until the fixture was fixed
  "2026-09-29T20-27-01-387Z:pi/debug-suite",
  "2026-09-29T20-27-01-387Z:omp/debug-suite",
  "2026-09-29T20-27-01-387Z:builtin/debug-suite",
  // big-file-normalize ran without SPEC.md until it moved into fixture/
  "2026-09-29T20-27-01-387Z:pi/big-file-normalize",
  "2026-09-29T20-27-01-387Z:omp/big-file-normalize",
  "2026-09-29T20-27-01-387Z:builtin/big-file-normalize",
  // builtin rows poisoned by the zombie session (its calls landed under these
  // labels after the bench driver timed out without cancelling the session)
  "2026-09-29T20-27-01-387Z:builtin/fix-sum",
  "2026-09-29T20-27-01-387Z:builtin/fizzbuzz",
  "2026-09-29T20-27-01-387Z:builtin/tool-failure-recovery",
]);

// Whole agent/stamp exclusions: rows whose per-task wire attribution is known
// wrong even though the pairs themselves ran. `docker cp` of the omp config
// nested into the existing /root/.omp, so every omp pair after the first on a
// slot called under the first pair's label (fixed in run-docker.mjs; see
// ITERATIONS.md §7). Keys are `<stamp>:<agent>` prefixes.
const SKIP_PREFIX = new Set([
  "docker-2026-10-01T00-38-00-165Z:omp",
  "docker-2026-10-01T00-58-56-845Z:omp",
  "docker-2026-10-01T01-17-26-975Z:omp",
]);

const rowsFor = new Map();
for (const f of readdirSync(RESULTS).sort()) {
  if (!f.endsWith(".jsonl") || f.endsWith(".calls.jsonl")) continue;
  if (f === "all-runs.jsonl") continue; // the ledger, not a stamp
  const stamp = f.slice(0, -".jsonl".length);
  const callsFile = path.join(RESULTS, `${stamp}.calls.jsonl`);
  if (!existsSync(callsFile)) continue; // no wire numbers -> unusable for baseline
  const runs = readFileSync(path.join(RESULTS, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!runs.length) continue;
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The wire model id groups runs: different models must never share a
  // best-of table, a best pi run on one model says nothing about another.
  const model = calls.find((c) => c.request?.model)?.request?.model ?? "unknown";
  const wire = new Map();
  for (const c of calls) {
    const k = `${c.label.agent}/${c.label.task}/${c.label.repeat}`;
    if (!wire.has(k)) wire.set(k, { calls: 0, prompt: 0, cached: 0, errors: 0 });
    const w = wire.get(k);
    w.calls += 1;
    if (c.status >= 400) w.errors += 1;
    const u = c.response?.usage;
    if (u && typeof u.prompt === "number") {
      w.prompt += u.prompt;
      w.cached += u.cached ?? 0;
    }
  }
  for (const r of runs) {
    const key = `${stamp}:${r.agent}/${r.task}`;
    if (SKIP.has(key)) continue;
    if ([...SKIP_PREFIX].some((p) => key.startsWith(p))) continue;
    const w = wire.get(`${r.agent}/${r.task}/${r.repeat}`);
    if (!w || !w.prompt) continue; // no usage captured (e.g. timed-out session)
    rowsFor.has(key) || rowsFor.set(key, []);
    rowsFor.get(key).push({
      stamp,
      model,
      ok: r.ok === true,
      wallMs: r.wallMs,
      tools: r.toolCalls,
      calls: w.calls,
      uncached: w.prompt - w.cached,
      out: (r.tokensOut ?? 0),
    });
  }
}

const byRef = new Map();
for (const [key, runs] of rowsFor) {
  const [agent, task] = key.split(":")[1].split("/");
  const ref = `${runs[0].model}/${agent}/${task}`;
  byRef.has(ref) || byRef.set(ref, []);
  byRef.get(ref).push(...runs);
}

const BEST = new Map(); // `<model>/<agent>/<task>` -> best passing run by uncached
for (const [ref, runs] of byRef) {
  const ok = runs.filter((r) => r.ok);
  if (!ok.length) continue;
  BEST.set(ref, ok.sort((a, b) => a.uncached - b.uncached)[0]);
}

const models = [...new Set([...BEST.keys()].map((r) => r.split("/")[0]))].sort();
for (const model of models) {
  if (modelArg && model !== modelArg) continue;
  const refs = [...BEST.keys()].filter((r) => r.split("/")[0] === model);
  const agents = [...new Set(refs.map((r) => r.split("/")[1]))].sort();
  const tasks = [...new Set(refs.map((r) => r.split("/")[2]))].sort();
  console.log(`\nModel \`${model}\` — best passing run per agent/task (uncached from the wire):\n`);
  console.log("task".padEnd(24) + agents.map((a) => `${a}: uncached/calls/wallS`.padEnd(26)).join(""));
  for (const t of tasks) {
    let line = t.padEnd(24);
    for (const a of agents) {
      const b = BEST.get(`${model}/${a}/${t}`);
      line += (b ? `${b.uncached}/${b.calls}/${Math.round(b.wallMs / 1000)}s` : "—").padEnd(26);
    }
    console.log(line);
  }
  console.log("");
  for (const a of agents) {
    let unc = 0, calls = 0, wall = 0, n = 0;
    for (const t of tasks) {
      const b = BEST.get(`${model}/${a}/${t}`);
      if (!b) continue;
      unc += b.uncached; calls += b.calls; wall += b.wallMs; n += 1;
    }
    console.log(`${a.padEnd(10)} best-of totals: uncached=${unc}  modelCalls=${calls}  avgWall=${Math.round(wall / n / 1000)}s  tasks=${n}`);
  }
}
