#!/usr/bin/env node
// Time-horizon ladder (METR-style): pass rate by the HUMAN time a task takes,
// not machine time. One flat pass rate over a uniformly short corpus says
// nothing about everyday capability; the ladder shows where the agent actually
// falls off. Reads the per-run ledgers and each task's horizon bucket.
//
//   node bench/horizon.mjs                      # every model, both ledgers
//   node bench/horizon.mjs --model local/local-model
//   node bench/horizon.mjs --ledger <file>      # extra per-run ledger
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BENCH = path.dirname(fileURLToPath(import.meta.url));

export const HORIZON_ORDER = ["xs", "s", "m", "l", "unknown"];
export const HORIZON_LABEL = { xs: "<15 min", s: "15-60 min", m: "1-4 hours", l: ">4 hours", unknown: "?" };

// SWE-bench Verified ships its own human-time difficulty annotation — use it
// verbatim as the instance's horizon.
const VERIFIED_MAP = { "<15 min fix": "xs", "15 min - 1 hour": "s", "1-4 hours": "m", ">4 hours": "l" };
// Synthetic corpus: bench difficulty is a rough human-time proxy. Every
// synthetic task is under an hour of human work; "hard" means fiddly, not long.
const DIFFICULTY_MAP = { easy: "xs", medium: "s", hard: "s" };

/** Resolve one task meta object to its horizon bucket. */
export function horizonOf(task) {
  if (!task) return "unknown";
  if (task.horizon) return task.horizon;
  if (VERIFIED_MAP[task.difficulty]) return VERIFIED_MAP[task.difficulty];
  if (DIFFICULTY_MAP[task.difficulty]) return DIFFICULTY_MAP[task.difficulty];
  return "unknown";
}

/** task id -> task.json across every task root this bench knows. */
export function loadTaskMeta() {
  const meta = new Map();
  for (const root of [path.join(BENCH, "tasks"), path.join(BENCH, "private", "tasks")]) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        meta.set(e.name, JSON.parse(readFileSync(path.join(root, e.name, "task.json"), "utf8")));
      } catch {}
    }
  }
  const data = path.join(BENCH, "swe", "data", "swe-bench-verified.jsonl");
  if (existsSync(data)) {
    for (const line of readFileSync(data, "utf8").trim().split("\n")) {
      try {
        const r = JSON.parse(line);
        if (!meta.has(r.instance_id)) meta.set(r.instance_id, r);
      } catch {}
    }
  }
  return meta;
}

/** Normalize every ledger's per-run row to {task, agent, ok, model, wallMs, uncached}. */
function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        return null;
      }
      if (r.instance !== undefined) {
        const inTok = typeof r.tokensIn === "number" ? r.tokensIn : null;
        const cached = typeof r.tokensCached === "number" ? r.tokensCached : null;
        return {
          task: r.instance,
          agent: r.agent,
          ok: r.resolved === true,
          model: r.model,
          wallMs: r.wallMs,
          uncached: inTok != null && cached != null ? inTok - cached : null,
        };
      }
      return {
        task: r.task,
        agent: r.agent,
        ok: r.ok === true,
        model: r.model,
        wallMs: r.wallMs,
        uncached: typeof r.uncachedTok === "number" ? r.uncachedTok : null,
      };
    })
    .filter(Boolean);
}

const DEFAULT_LEDGERS = [path.join(BENCH, "results", "all-runs.jsonl"), path.join(BENCH, "results", "swe-all-runs.jsonl")];

function main() {
  const argv = process.argv.slice(2);
  let model = null;
  const ledgers = [...DEFAULT_LEDGERS];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--ledger") ledgers.push(path.resolve(argv[++i]));
    else throw new Error(`unknown flag: ${argv[i]}`);
  }
  const meta = loadTaskMeta();
  const rows = ledgers
    .flatMap((f) => readLedger(f))
    .filter((r) => typeof r.agent === "string" && typeof r.task === "string")
    .filter((r) => !model || r.model === model);
  if (!rows.length) {
    console.log(model ? `no rows for model ${model}` : "ledgers are empty");
    return;
  }
  const models = [...new Set(rows.map((r) => r.model))].sort();
  for (const m of models) {
    const mrows = rows.filter((r) => r.model === m);
    const agents = [...new Set(mrows.map((r) => r.agent))].sort();
    console.log(`\nmodel \`${m}\` — pass rate by estimated human time:\n`);
    console.log(`  ${"agent".padEnd(10)}${"horizon".padEnd(10)}${"runs".padStart(5)}${"pass".padStart(6)}${"pass%".padStart(7)}${"avg wall".padStart(10)}${"sum uncached".padStart(14)}`);
    for (const agent of agents) {
      for (const h of HORIZON_ORDER) {
        const rs = mrows.filter((r) => r.agent === agent && horizonOf(meta.get(r.task)) === h);
        if (!rs.length) continue;
        const ok = rs.filter((r) => r.ok).length;
        const wall = rs.reduce((n, r) => n + (typeof r.wallMs === "number" ? r.wallMs : 0), 0) / rs.length;
        const uncached = rs.reduce((n, r) => n + (r.uncached ?? 0), 0);
        console.log(
          `  ${agent.padEnd(10)}${(HORIZON_LABEL[h] ?? h).padEnd(10)}${String(rs.length).padStart(5)}${String(ok).padStart(6)}${((100 * ok) / rs.length).toFixed(0).padStart(6)}%${(Math.round(wall / 1000) + "s").padStart(10)}${String(uncached).padStart(14)}`,
        );
      }
    }
    const unknown = [...new Set(mrows.map((r) => r.task).filter((t) => !meta.get(t)))];
    if (unknown.length) console.log(`\n  no meta for ${unknown.length} task id(s), they count under "?"`);
  }
  console.log("");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
