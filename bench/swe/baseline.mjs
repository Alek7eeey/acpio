#!/usr/bin/env node
// Frozen baseline for the SWE-bench Verified corpus: the BEST passing run per
// agent/instance across every recorded run, grouped by the model the wire saw.
// The builtin agent changes between iterations; pi and omp do not — so their
// reference is their best observed run too, not whichever stamp sat next to the
// latest builtin attempt.
//
// Tokens come from each stamp's swe-<stamp>.calls.jsonl (the wire): CLI agents'
// self-reports undercount (they mostly drop cached tokens and whole calls).
//
//   node bench/swe/baseline.mjs                  # all models
//   node bench/swe/baseline.mjs --model local/local-model
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "results");

const modelArg = (() => {
  const i = process.argv.indexOf("--model");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// Stamps that must not feed the baseline. 2026-09-30T13-58: wire labels were
// scrambled (concurrent rollouts shared the proxy's mutable label before
// per-request `/_lbl/` labeling existed), so its per-agent token attribution
// is wrong.
const SKIP_STAMPS = new Set(["2026-09-30T13-58-25-770Z"]);

const byRef = new Map(); // `<model>/<agent>/<instance>` -> runs[]
// The run index is the stamp -> model map: the wire's `request.model` is what
// the harness happened to send (builtin labels it differently from pi/omp).
// It also carries the stamp's gold flag: --gold self-tests grade the reference
// patch (recorded as agent=builtin resolved rows, no per-row gold field), so
// they must never feed a baseline.
const stampModel = new Map();
const GOLD_STAMPS = new Set();
const runsIndex = path.join(RESULTS, "swe-runs.jsonl");
if (existsSync(runsIndex)) {
  for (const l of readFileSync(runsIndex, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    stampModel.set(r.stamp, r.model);
    if (r.gold) GOLD_STAMPS.add(r.stamp);
  }
}
// Stamps older than the run index: the per-instance ledger carries the model too.
const ledger = path.join(RESULTS, "swe-all-runs.jsonl");
if (existsSync(ledger)) {
  for (const l of readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.model && !stampModel.has(r.stamp)) stampModel.set(r.stamp, r.model);
    if (r.gold && r.stamp) GOLD_STAMPS.add(r.stamp);
  }
}
for (const f of readdirSync(RESULTS).sort()) {
  if (!f.startsWith("swe-") || !f.endsWith(".jsonl") || f.endsWith(".calls.jsonl")) continue;
  if (["swe-all-runs.jsonl", "swe-runs.jsonl"].includes(f)) continue; // ledgers, not stamps
  const stamp = f.slice("swe-".length, -".jsonl".length);
  if (SKIP_STAMPS.has(stamp) || GOLD_STAMPS.has(stamp)) continue;
  const callsFile = path.join(RESULTS, `${f.slice(0, -".jsonl".length)}.calls.jsonl`);
  if (!existsSync(callsFile)) continue; // no wire numbers -> not a baseline row
  const runs = readFileSync(path.join(RESULTS, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!runs.length) continue;
  const model = stampModel.get(stamp) ?? "unknown";
  const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const wire = new Map();
  for (const c of calls) {
    const k = `${c.label?.agent}/${c.label?.task}`;
    if (!wire.has(k)) wire.set(k, { calls: 0, prompt: 0, cached: 0, completion: 0 });
    const w = wire.get(k);
    w.calls += 1;
    const u = c.response?.usage;
    if (u && typeof u.prompt === "number") {
      w.prompt += u.prompt;
      w.cached += u.cached ?? 0;
      w.completion += u.completion ?? 0;
    }
  }
  for (const r of runs) {
    if (r.agent == null || r.instanceId == null) continue;
    const key = `${stamp}:${r.agent}/${r.instanceId}`;
    const w = wire.get(`${r.agent}/${r.instanceId}`);
    if (!w || !w.prompt) continue; // crashed before any model call
    byRef.has(key) || byRef.set(key, []);
    byRef.get(key).push({
      stamp,
      model,
      ok: r.resolved === true,
      rolloutMs: r.metrics?.wallMs ?? r.rolloutMs ?? r.wallMs,
      evalMs: r.evalMs ?? 0,
      tools: r.metrics?.toolCalls ?? r.toolCalls ?? 0,
      uncached: w.prompt - w.cached,
      out: w.completion,
      gold: Boolean(r.gold),
    });
  }
}

// Structured best entries (model ids contain "/", so never parse them out of
// a joined key): one best passing run per (model, agent, instance).
const BEST = [];
for (const [key, runs] of byRef) {
  const rest = key.slice(key.indexOf(":") + 1);
  const ok = runs.filter((r) => r.ok && !r.gold);
  if (!ok.length) continue;
  BEST.push({
    model: runs[0].model,
    agent: rest.slice(0, rest.indexOf("/")),
    instance: rest.slice(rest.indexOf("/") + 1),
    ...ok.sort((a, b) => a.uncached - b.uncached)[0],
  });
}

const models = [...new Set(BEST.map((b) => b.model))].sort();
for (const model of models) {
  if (modelArg && model !== modelArg) continue;
  const inModel = BEST.filter((b) => b.model === model);
  const agents = [...new Set(inModel.map((b) => b.agent))].sort();
  const instances = [...new Set(inModel.map((b) => b.instance))].sort();
  console.log(`\nModel \`${model}\` — best RESOLVED run per agent/instance (tokens from the wire):\n`);
  console.log("instance".padEnd(34) + agents.map((a) => `${a}: uncached/tools/rolloutS`.padEnd(30)).join(""));
  for (const inst of instances) {
    let line = inst.padEnd(34);
    for (const a of agents) {
      const b = inModel.find((x) => x.agent === a && x.instance === inst);
      line += (b ? `${b.uncached}/${b.tools}/${Math.round(b.rolloutMs / 1000)}s` : "—").padEnd(30);
    }
    console.log(line);
  }
  console.log("");
  for (const a of agents) {
    let unc = 0, tools = 0, rollout = 0, n = 0, resolvedTotal = 0, runsTotal = 0;
    for (const [key, runs] of byRef) {
      const rest = key.slice(key.indexOf(":") + 1); // <agent>/<instance>
      const agent = rest.slice(0, rest.indexOf("/"));
      const inst = rest.slice(rest.indexOf("/") + 1);
      const m = runs[0].model; // a stamp runs on one model
      if (m !== model || agent !== a) continue;
      runsTotal += runs.filter((r) => !r.gold).length;
      resolvedTotal += runs.filter((r) => r.ok && !r.gold).length;
      const b = inModel.find((x) => x.agent === a && x.instance === inst);
      if (!b) continue;
      unc += b.uncached;
      tools += b.tools;
      rollout += b.rolloutMs;
      n += 1;
    }
    console.log(
      `${a.padEnd(10)} best-of totals: uncached=${unc}  tools=${tools}  avgRollout=${n ? Math.round(rollout / n / 1000) : 0}s  resolved=${resolvedTotal}/${runsTotal} (all recorded runs)`,
    );
  }
}
