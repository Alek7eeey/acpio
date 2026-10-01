#!/usr/bin/env node
// Summary grid of one bench run — the thing to paste at the end of an
// iteration journal entry. Reads the run's own result files plus the
// append-only journal; the frozen best-of baseline is printed for context
// only (best-of is a warm-cache composite, a single run rarely compares
// directly — see ITERATIONS.md §2).
//
// The first-call floor is averaged over *all* first calls (a request with
// just system+user on the wire), not per task: the static prefix is identical
// across tasks, so the average stays correct even when per-task wire labels
// are scrambled (ITERATIONS.md §7, slot-server artifact).
//
//   node bench/grid.mjs <stamp> [--floor-prev <stamp>]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(REPO, "bench", "results");

const stamp = process.argv[2];
const prevIdx = process.argv.indexOf("--floor-prev");
const prevStamp = prevIdx > 0 ? process.argv[prevIdx + 1] : null;
if (!stamp || (prevIdx > 0 && !prevStamp)) {
  console.error("usage: node bench/grid.mjs <stamp> [--floor-prev <stamp>]");
  process.exit(1);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (n) => n.toLocaleString("ru-RU").replace(/\u00A0/g, " ");
const readLines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

// ── Harness rows: pass / wall / tools, per task. ────────────────────────────
const rows = readLines(path.join(RESULTS, `${stamp}.jsonl`)).map((r) => ({
  agent: r.agent,
  task: r.task,
  ok: r.ok,
  wallMs: num(r.wallMs),
  tools: num(r.metrics?.toolCalls ?? r.toolCalls),
  toolErrors: num(r.metrics?.toolErrors ?? r.toolErrors),
}));

// ── Journal: git, model, wire tokens per task (repairs included). ───────────
// The docker contour stamps its files `docker-<stamp>` but journals rows under
// the bare stamp, aggregated per run (`wire` per agent, no per-task rows).
const bareStamp = stamp.replace(/^docker-/, "");
const journal = [
  ...readLines(path.join(RESULTS, "all-runs.jsonl")),
  ...readLines(path.join(RESULTS, "docker-all-runs.jsonl")),
].filter((r) => r.stamp === stamp || r.stamp === bareStamp);
const meta = journal[0] ?? {};
const wireByTask = new Map(journal.map((r) => [`${r.agent ?? "?"}/${r.task}`, r]).filter(([k]) => !k.endsWith("/undefined")));
const wireByAgent = new Map(
  Object.entries(meta.wire ?? {}).map(([agent, w]) => [agent, w]),
);

// ── Wire: per-call usage and the first-call floor. ──────────────────────────
const calls = readLines(path.join(RESULTS, `${stamp}.calls.jsonl`));
const perAgent = new Map();
for (const c of calls) {
  const agent = c.label?.agent ?? "?";
  const a = perAgent.get(agent) ?? { firsts: [], usage: 0, reported: 0, taskCalls: new Map() };
  const u = c.response?.usage ?? null;
  if (u) {
    a.usage += 1;
    if (c.request?.messages === 2) a.firsts.push(num(u.prompt));
  }
  const key = `${agent}/${c.label?.task}`;
  a.taskCalls.set(key, (num(u?.prompt) - num(u?.cached)));
  perAgent.set(agent, a);
}

// Journal wire sums win (they survive label repairs); wire file fills the rest.
const sumWire = (agent) => {
  let calls = 0, prompt = 0, cached = 0, unc = 0, out = 0;
  for (const [key, r] of wireByTask) {
    if (!key.startsWith(`${agent}/`)) continue;
    calls += num(r.modelCalls);
    prompt += num(r.promptTok);
    cached += num(r.cachedTok);
    unc += num(r.uncachedTok);
    out += num(r.outTok);
  }
  if (!calls && wireByAgent.has(agent)) {
    const w = wireByAgent.get(agent);
    calls = num(w.calls);
    prompt = num(w.prompt);
    cached = num(w.cached);
    unc = prompt - cached;
    out = num(w.completion);
  }
  return { calls, prompt, cached, unc, out };
};

const floorStats = (agent) => {
  const firsts = perAgent.get(agent)?.firsts ?? [];
  if (!firsts.length) return null;
  const avg = Math.round(firsts.reduce((s, n) => s + n, 0) / firsts.length);
  return { avg, min: Math.min(...firsts), max: Math.max(...firsts), n: firsts.length };
};

const floorPrev = prevStamp
  ? (() => {
      const prev = readLines(path.join(RESULTS, `${prevStamp}.calls.jsonl`));
      const byAgent = new Map();
      for (const c of prev) {
        if (c.request?.messages !== 2 || !c.response?.usage) continue;
        const agent = c.label?.agent ?? "?";
        if (!byAgent.has(agent)) byAgent.set(agent, []);
        byAgent.get(agent).push(num(c.response.usage.prompt));
      }
      return byAgent;
    })()
    : null;

// ── Frozen best-of baseline, for context only. ──────────────────────────────
const baseline = (() => {
  const modelId = String(meta.model ?? "").split("/").pop();
  if (!modelId) return new Map();
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, "bench", "baseline.mjs"), "--model", modelId], {
      cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const map = new Map();
    for (const m of out.matchAll(/(\S+)\s+best-of totals: uncached=(\d+)\s+modelCalls=(\d+)\s+avgWall=(\d+)s/g)) {
      map.set(m[1], { unc: num(Number(m[2])), calls: num(Number(m[3])), wall: num(Number(m[4])) });
    }
    return map;
  } catch {
    return new Map();
  }
})();

// ── The grid. ────────────────────────────────────────────────────────────────
const agents = [...new Set(rows.map((r) => r.agent))];
const tasks = new Set(rows.map((r) => r.task)).size;
const date = String(meta.ts ?? stamp).slice(0, 16).replace("T", " ");

console.log(`## Запуск \`${stamp}\``);
console.log("");
console.log(
  `${date} · git \`${meta.git ?? "?"}\` · модель \`${meta.model ?? "?"}\` · ` +
  `задач ${tasks} · ${agents.join(", ")}`,
);
console.log("");
console.log(
  "| агент | pass | вызовы | инструменты/ошибки | uncached | cached | кэш % | out | время (ср/сумм) | пол 1-го вызова |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const agent of agents) {
  const rs = rows.filter((r) => r.agent === agent);
  const w = sumWire(agent);
  const callsN = w.calls || [...(perAgent.get(agent)?.taskCalls ?? [])].length;
  const pass = rs.filter((r) => r.ok).length;
  const tools = rs.reduce((s, r) => s + r.tools, 0);
  const errs = rs.reduce((s, r) => s + r.toolErrors, 0);
  const wallSum = rs.reduce((s, r) => s + r.wallMs, 0);
  const wallAvg = rs.length ? Math.round(wallSum / rs.length / 1000) : 0;
  const floor = floorStats(agent);
  const floorStr = floor
    ? `${fmt(floor.avg)} (${fmt(floor.min)}–${fmt(floor.max)}, n=${floor.n})`
    : "—";
  // Cache rate is diagnostics, not a score (ITERATIONS.md §1): it rises when
  // the stable prefix bloats, which is the omp trap.
  const rate = w.prompt ? `${Math.round((w.cached / w.prompt) * 100)}%` : "—";
  console.log(
    `| ${agent} | ${pass}/${rs.length} | ${fmt(w.calls || callsN)} | ` +
    `${tools}/${errs} | ${fmt(w.unc)} | ${fmt(w.cached)} | ${rate} | ${fmt(w.out)} | ` +
    `${wallAvg}с / ${Math.round(wallSum / 1000)}с | ${floorStr} |`,
  );
}
console.log("");
if (baseline.size) {
  const parts = agents
    .filter((a) => baseline.has(a))
    .map((a) => `${a} ${fmt(baseline.get(a).unc)} unc / ${baseline.get(a).calls} выз / ${baseline.get(a).wall}с`);
  if (parts.length) console.log(`Best-of baseline (${String(meta.model ?? "").split("/").pop()}, тёплый кэш — контекст, не соперник): ${parts.join(" · ")}`);
}
if (floorPrev?.size) {
  const parts = agents
    .filter((a) => floorPrev.has(a))
    .map((a) => {
      const v = floorPrev.get(a);
      return `${a} ${fmt(Math.round(v.reduce((s, n) => s + n, 0) / v.length))} (n=${v.length})`;
    });
  if (parts.length) console.log(`Пол предыдущего прогона \`${prevStamp}\`: ${parts.join(" · ")}`);
}
