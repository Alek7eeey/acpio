#!/usr/bin/env node
// One-off aggregation for the 100-instance Verified corpus: best RESOLVED run
// per agent/instance over every recorded zen-model stamp (same rule as
// bench/swe/baseline.mjs), restricted to bench/swe/corpus.txt.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const RESULTS = "bench/results";
const corpus = new Set(readFileSync("bench/swe/corpus.txt", "utf8").trim().split("\n"));
const SKIP = new Set(["2026-09-30T13-58-25-770Z"]); // scrambled wire labels, see baseline.mjs

const stampModel = new Map();
const GOLD = new Set();
for (const f of ["swe-runs.jsonl", "swe-all-runs.jsonl"]) {
  const p = path.join(RESULTS, f);
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").trim().split("\n").filter(Boolean)) {
    const r = JSON.parse(l);
    if (r.model && r.stamp && !stampModel.has(r.stamp)) stampModel.set(r.stamp, r.model);
    if (r.gold && r.stamp) GOLD.add(r.stamp);
  }
}
const isZen = (stamp) => /^(zen|opencode-zen)\//.test(stampModel.get(stamp) ?? "");

const per = new Map(); // agent -> instance -> best record
for (const f of readdirSync(RESULTS).sort()) {
  if (!f.startsWith("swe-") || !f.endsWith(".jsonl") || f.endsWith(".calls.jsonl")) continue;
  if (["swe-all-runs.jsonl", "swe-runs.jsonl"].includes(f)) continue;
  const stamp = f.slice(4, -6);
  if (SKIP.has(stamp) || GOLD.has(stamp) || !isZen(stamp)) continue;
  let rows;
  try {
    rows = readFileSync(path.join(RESULTS, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { continue; }
  for (const r of rows) {
    if (!corpus.has(r.instanceId) || r.gold) continue;
    const byInstance = per.get(r.agent) ?? new Map();
    per.set(r.agent, byInstance);
    const m = r.metrics ?? {};
    const uncached = Math.max(0, (m.tokensIn ?? 0) - (m.tokensCached ?? 0));
    const cand = {
      resolved: r.resolved === true,
      uncached,
      rollout: Math.round((m.wallMs ?? r.wallMs ?? 0) / 1000),
      tools: m.toolCalls ?? 0,
      stamp,
    };
    const prev = byInstance.get(r.instanceId);
    if (!prev || (cand.resolved && (!prev.resolved || cand.uncached < prev.uncached))) byInstance.set(r.instanceId, cand);
  }
}

console.log("100-instance Verified corpus — best RESOLVED per agent/instance, zen wire:");
for (const agent of ["builtin", "pi", "omp"]) {
  const byInstance = per.get(agent) ?? new Map();
  const resolved = [...byInstance.entries()].filter(([, v]) => v.resolved);
  const unc = resolved.reduce((s, [, v]) => s + v.uncached, 0);
  const rolls = resolved.map(([, v]) => v.rollout).sort((a, b) => a - b);
  const med = rolls.length ? rolls[Math.floor(rolls.length / 2)] : 0;
  const fails = [...byInstance.entries()].filter(([, v]) => !v.resolved).map(([id]) => id);
  console.log(`\n${agent}: covered ${byInstance.size}/100, RESOLVED ${resolved.length}`);
  console.log(`  uncached total ${Math.round(unc / 1000)}k, per resolved ${resolved.length ? Math.round(unc / resolved.length / 1000) + "k" : "-"}, median rollout ${med}s, total tools ${resolved.reduce((s, [, v]) => s + v.tools, 0)}`);
  console.log(fails.length ? `  fails (${fails.length}): ${fails.join(", ")}` : "  fails: none");
}
