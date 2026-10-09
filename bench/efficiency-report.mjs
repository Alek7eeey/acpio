#!/usr/bin/env node
// Efficiency report: builtin (acp) vs pi vs omp, per task, as a standalone HTML.
//
// Data: the append-only ledgers bench/results/all-runs.jsonl (host synthetic
// corpus) and bench/results/swe-all-runs.jsonl (SWE Verified corpus), rows on
// the shared space-bunny-free model (`zen/` and `opencode-zen/` prefixes are
// the same endpoint, merged by suffix). Token counts are read from each
// stamp's wire (.calls.jsonl), the same source bench/baseline.mjs uses: the
// swe ledger recorded tokensCached=0 for pi/omp (the session API does not
// propagate cachedInputTokens for the cli adapters) even though the wire has
// it; ledger token fields are only a fallback when no calls file exists.
//
// Per agent/task the reference run is picked with the same rule as
// bench/baseline.mjs: the best PASSING run by uncached tokens. Runs without
// wire usage, faulted runs and the baseline SKIP list are excluded. A task
// enters its table when at least two agents have a reference run; totals are
// summed over tasks where all three pass (apples-to-apples).
//
//   node bench/efficiency-report.mjs                 # writes bench/results/efficiency-report.html
//   node bench/efficiency-report.mjs --out <path>    # custom output path
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : path.join(RESULTS, "efficiency-report.html");
})();

const AGENTS = ["builtin", "pi", "omp"];
const AGENT_LABEL = { builtin: "acp (builtin)", pi: "pi", omp: "omp" };
const MODEL_SUFFIX = "space-bunny-free";

// Same exclusions as bench/baseline.mjs: broken fixtures and rows poisoned by
// the zombie session. Keys are `<stamp>:<agent>/<task>`.
const SKIP = new Set([
  "2026-09-29T20-27-01-387Z:pi/debug-suite",
  "2026-09-29T20-27-01-387Z:omp/debug-suite",
  "2026-09-29T20-27-01-387Z:builtin/debug-suite",
  "2026-09-29T20-27-01-387Z:pi/big-file-normalize",
  "2026-09-29T20-27-01-387Z:omp/big-file-normalize",
  "2026-09-29T20-27-01-387Z:builtin/big-file-normalize",
  "2026-09-29T20-27-01-387Z:builtin/fix-sum",
  "2026-09-29T20-27-01-387Z:builtin/fizzbuzz",
  "2026-09-29T20-27-01-387Z:builtin/tool-failure-recovery",
]);

// Same stamp exclusions as bench/swe/baseline.mjs: the wire labels were
// scrambled before per-request `/_lbl/` labeling existed.
const SWE_SKIP_STAMPS = new Set(["2026-09-30T13-58-25-770Z"]);

// Stamps recorded as gold self-tests (the reference patch graded, no agent
// work) must never feed the comparison.
const GOLD_STAMPS = new Set();
for (const f of ["swe-runs.jsonl", "swe-all-runs.jsonl"]) {
  try {
    for (const l of readLedger(f)) if (l.gold && l.stamp) GOLD_STAMPS.add(l.stamp);
  } catch {}
}

const readLedger = (name) =>
  readFileSync(path.join(RESULTS, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---- wire usage per stamp --------------------------------------------------

// Proxy wire (.calls.jsonl) keyed `agent/task/repeat` -> summed usage. Labels
// in the swe calls files always carry repeat=1, so a `agent/task` lookup with
// repeat 1 matches them.
//
// Keys whose call series shows more than one context restart (a small prompt
// right after a large one) are label merges — two pairs sharing one wire
// label (the disease behind the scrambled 2026-09-30 stamp, in milder form
// through 10-02). Their per-pair attribution is wrong, so the key is dropped
// entirely rather than trusted; the pair falls back to another stamp's run.
const wireCache = new Map();
function wireMap(file) {
  if (wireCache.has(file)) return wireCache.get(file);
  let map;
  try {
    map = new Map();
    const series = new Map();
    for (const l of readFileSync(path.join(RESULTS, file), "utf8").split("\n")) {
      if (!l) continue;
      let c;
      try { c = JSON.parse(l); } catch { continue; }
      const u = c.response?.usage;
      if (!c.label?.agent || !c.label?.task || typeof u?.prompt !== "number") continue;
      const k = `${c.label.agent}/${c.label.task}/${c.label.repeat ?? 1}`;
      (series.get(k) ?? series.set(k, []).get(k)).push(u.prompt);
      const w = map.get(k) ?? { prompt: 0, cached: 0, completion: 0 };
      w.prompt += u.prompt;
      w.cached += u.cached ?? 0;
      w.completion += u.completion ?? 0;
      map.set(k, w);
    }
    for (const [k, ps] of series) {
      let restarts = 0;
      for (let i = 1; i < ps.length; i++) if (ps[i] < ps[i - 1] * 0.5 && ps[i] < 20000) restarts += 1;
      if (restarts > 1) map.delete(k);
    }
  } catch {
    map = null; // no calls file for this stamp -> fall back to ledger numbers
  }
  wireCache.set(file, map);
  return map;
}

// ---- corpus row shapes -----------------------------------------------------

// host ledger row + wire -> unified candidate
function hostRow(r, wire) {
  if (!AGENTS.includes(r.agent)) return null;
  if ((r.model || "").split("/").pop() !== MODEL_SUFFIX) return null;
  if (r.faults) return null; // fault injection is an A/B, not an efficiency run
  if (SKIP.has(`${r.stamp}:${r.agent}/${r.task}`)) return null;
  if (!wire) return null; // no wire numbers -> not a baseline row (baseline.mjs rule)
  const w = wire.get(`${r.agent}/${r.task}/${r.repeat ?? 1}`);
  if (!w || !(w.prompt > 0)) return null; // no wire usage captured
  return {
    ok: r.ok === true,
    wallMs: r.wallMs,
    tools: r.tools,
    prompt: w.prompt,
    cached: w.cached,
    uncached: w.prompt - w.cached,
    out: w.completion,
    label: r.task,
    sub: "",
  };
}

// The canonical 100-instance Verified corpus (bench/swe/corpus.txt).
const SWE_CORPUS = new Set(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "swe", "corpus.txt"), "utf8")
    .split("\n")
    .filter(Boolean),
);

// Relaxed swe row: same ledger filters, no wire requirement — used only to
// report passes that a clean wire attribution cannot show (they are why this
// report's pass counts can sit below the journal's ledger-based counts).
function sweLooseRow(r) {
  if (!AGENTS.includes(r.agent)) return null;
  if ((r.model || "").split("/").pop() !== MODEL_SUFFIX) return null;
  if (SWE_SKIP_STAMPS.has(r.stamp) || GOLD_STAMPS.has(r.stamp)) return null;
  if (!SWE_CORPUS.has(r.instance)) return null;
  if (!(r.tokensIn > 0)) return null;
  return { ok: r.resolved === true, label: r.instance, sub: r.repo || "" };
}

// swe ledger row + wire -> unified candidate
function sweRow(r, wire) {
  if (!AGENTS.includes(r.agent)) return null;
  if ((r.model || "").split("/").pop() !== MODEL_SUFFIX) return null;
  if (SWE_SKIP_STAMPS.has(r.stamp) || GOLD_STAMPS.has(r.stamp)) return null;
  if (!SWE_CORPUS.has(r.instance)) return null;
  if (!wire) return null; // no wire numbers -> not a baseline row (baseline.mjs rule)
  const w = wire.get(`${r.agent}/${r.instance}/1`);
  if (!w || !(w.prompt > 0)) return null; // broken pair (session error, no usage)
  return {
    ok: r.resolved === true,
    wallMs: r.wallMs,
    tools: r.toolCalls,
    prompt: w.prompt,
    cached: w.cached,
    uncached: w.prompt - w.cached,
    out: w.completion,
    label: r.instance,
    sub: r.repo || "",
  };
}

// best passing run by uncached; fallback: best run overall, flagged as failed
function bestRun(cands) {
  if (!cands.length) return null;
  const byUnc = (a, b) => a.uncached - b.uncached;
  const pass = cands.filter((c) => c.ok).sort(byUnc)[0];
  if (pass) return { ...pass, failed: false };
  return { ...[...cands].sort(byUnc)[0], failed: true };
}

function collectCorpus(ledgerFile, rowFn, callsPrefix = "") {
  const cands = new Map(); // task -> agent -> candidate[]
  for (const raw of readLedger(ledgerFile)) {
    const wire = wireMap(`${callsPrefix}${raw.stamp}.calls.jsonl`) ?? wireMap(`${raw.stamp}.calls.jsonl`);
    const c = rowFn(raw, wire);
    if (!c) continue;
    const key = c.sub ? `${c.sub}::${c.label}` : c.label;
    cands.has(key) || cands.set(key, {});
    (cands.get(key)[raw.agent] ||= []).push(c);
  }
  const tasks = new Map(); // task -> {label, sub, agent: best}
  for (const [key, perAgent] of cands) {
    const best = {};
    for (const a of AGENTS) if (perAgent[a]) best[a] = bestRun(perAgent[a]);
    if (AGENTS.filter((a) => best[a]).length < 2) continue; // not a comparison
    const [sub, label] = key.includes("::") ? key.split("::") : ["", key];
    tasks.set(key, { label, sub, ...best });
  }
  return tasks;
}

// ---- metrics ---------------------------------------------------------------

const METRICS = [
  { id: "cachePct", title: "Кэш %", hint: "cached / prompt × 100", higherBetter: true },
  { id: "total", title: "Всего ток.", hint: "prompt + output", higherBetter: false },
  { id: "cached", title: "Кэшир.", hint: "токены из кэша", higherBetter: true },
  { id: "uncached", title: "Без кэша", hint: "полный ввод (биллинг по полной)", higherBetter: false },
  { id: "out", title: "Выход", hint: "выходные токены", higherBetter: false },
  { id: "tools", title: "Тулзы", hint: "вызовы инструментов", higherBetter: false },
  { id: "wall", title: "Время", hint: "wall-время прогона", higherBetter: false },
];

const metricValue = (run, id) => {
  if (!run) return null;
  switch (id) {
    case "cachePct": return (run.cached / run.prompt) * 100;
    case "total": return run.prompt + run.out;
    case "cached": return run.cached;
    case "uncached": return run.uncached;
    case "out": return run.out;
    case "tools": return run.tools;
    case "wall": return run.wallMs;
    default: return null;
  }
};

const nf = new Intl.NumberFormat("ru-RU");
const fmtInt = (v) => (v == null ? "—" : nf.format(Math.round(v)));
const fmtPct1 = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtDelta = (v) => {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.05) return "0%";
  const a = Math.abs(v);
  const abs = a >= 10 ? String(Math.round(a)) : a.toFixed(1);
  return `${v > 0 ? "+" : "−"}${abs}%`;
};
const fmtWall = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const fmtCell = (v, id) => (id === "wall" ? fmtWall(v) : id === "cachePct" ? fmtPct1(v) : fmtInt(v));

// delta of acp relative to other, in %, with the metric's "better" direction baked in
function deltaPct(mine, other, higherBetter) {
  if (mine == null || other == null || other === 0) return null;
  const raw = ((mine - other) / Math.abs(other)) * 100;
  return higherBetter ? raw : -raw; // positive = acp better
}

// ---- HTML ------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function agentCells(run, failed) {
  return METRICS.map((m) => {
    const v = metricValue(run, m.id);
    const cls = failed ? ' class="fail"' : "";
    return `<td${cls}>${v == null ? "—" : fmtCell(v, m.id)}</td>`;
  }).join("");
}

function absoluteTable(tasks) {
  const rows = [...tasks.values()]
    .sort((a, b) => (a.sub + a.label).localeCompare(b.sub + b.label))
    .map((t) => {
      const sub = t.sub ? `<span class="sub">${esc(t.sub)}/</span><br>` : "";
      const badges = AGENTS.filter((a) => t[a]?.failed)
        .map((a) => `<span class="badge" title="нет проходного прогона — показан лучший из непройденных">✗ ${AGENT_LABEL[a]}</span>`)
        .join(" ");
      return `<tr><th class="task">${sub}${esc(t.label)}${badges}</th>${AGENTS.map((a) => agentCells(t[a], t[a]?.failed)).join("")}</tr>`;
    })
    .join("\n");
  const head = METRICS.map((m) => `<th title="${esc(m.hint)}">${m.title}</th>`).join("");
  return `<table>
<thead><tr><th class="task">Задача</th>${AGENTS.map((a) => `<th colspan="7" class="agent">${AGENT_LABEL[a]}</th>`).join("")}</tr>
<tr><th class="task"></th>${AGENTS.map(() => head).join("")}</tr></thead>
<tbody>${rows}</tbody></table>`;
}

function deltaTable(tasks, self, other) {
  const rows = [...tasks.values()]
    .sort((a, b) => (a.sub + a.label).localeCompare(b.sub + b.label))
    .map((t) => {
      const cells = METRICS.map((m) => {
        const mine = metricValue(t[self], m.id);
        const oth = metricValue(t[other], m.id);
        const d = t[self] && t[other] && !t[self].failed && !t[other].failed ? deltaPct(mine, oth, m.higherBetter) : null;
        const cls = d == null ? "na" : d > 0.05 ? "good" : d < -0.05 ? "bad" : "zero";
        return `<td class="${cls}">${fmtDelta(d)}</td>`;
      }).join("");
      const sub = t.sub ? `<span class="sub">${esc(t.sub)}/</span><br>` : "";
      return `<tr><th class="task">${sub}${esc(t.label)}</th>${cells}</tr>`;
    })
    .join("\n");
  const head = METRICS.map((m) => `<th title="${esc(m.hint)}">${m.title}</th>`).join("");
  return `<table>
<thead><tr><th class="task">Задача</th><th colspan="7" class="agent">${AGENT_LABEL[self]} vs ${AGENT_LABEL[other]}<span class="legend">зелёный = acp лучше</span></th></tr>
<tr><th class="task"></th>${head}</tr></thead>
<tbody>${rows}</tbody></table>`;
}

function totals(tasks) {
  const common = [...tasks.values()].filter((t) => AGENTS.every((a) => t[a] && !t[a].failed));
  const out = {};
  for (const a of AGENTS) {
    const runs = common.map((t) => t[a]).filter(Boolean);
    const sum = (id) => runs.reduce((s, r) => s + metricValue(r, id), 0);
    const prompt = runs.reduce((s, r) => s + r.prompt, 0);
    const cached = runs.reduce((s, r) => s + r.cached, 0);
    out[a] = {
      n: runs.length,
      cachePct: prompt ? (cached / prompt) * 100 : null,
      total: sum("total"),
      cached,
      uncached: sum("uncached"),
      out: sum("out"),
      tools: sum("tools"),
      wall: sum("wall"),
      pass: [...tasks.values()].filter((t) => t[a] && !t[a].failed).length,
      shown: [...tasks.values()].filter((t) => t[a]).length,
    };
  }
  return out;
}

function summaryTable(tot, tasks, corpusTitle) {
  const rows = AGENTS.map((a) => {
    const t = tot[a];
    const cells = METRICS.map((m) => {
      const v = t[m.id];
      return `<td>${m.id === "wall" ? fmtWall(v) : m.id === "cachePct" ? fmtPct1(v) : fmtInt(v)}</td>`;
    }).join("");
    return `<tr><th class="task">${AGENT_LABEL[a]}</th><td>${t.pass}/${t.shown}</td>${cells}</tr>`;
  }).join("\n");
  const deltas = ["pi", "omp"].map((o) => {
    const cells = METRICS.map((m) => {
      const d = deltaPct(tot.builtin[m.id], tot[o][m.id], m.higherBetter);
      const cls = d == null ? "na" : d > 0.05 ? "good" : d < -0.05 ? "bad" : "zero";
      return `<td class="${cls}">${fmtDelta(d)}</td>`;
    }).join("");
    return `<tr><th class="task">${AGENT_LABEL.builtin} vs ${AGENT_LABEL[o]}</th><td class="na">—</td>${cells}</tr>`;
  }).join("\n");
  const head = METRICS.map((m) => `<th title="${esc(m.hint)}">${m.title}</th>`).join("");
  return `<p class="note">Суммы — только по задачам, где все три агента прошли (${tot.builtin.n} шт.); «прошёл» — из задач таблицы ниже.</p>
<table>
<thead><tr><th class="task">${esc(corpusTitle)}</th><th>Прошёл</th>${head}</tr></thead>
<tbody>${rows}${deltas}</tbody></table>`;
}

// ---- build -----------------------------------------------------------------

const host = collectCorpus("all-runs.jsonl", hostRow);
const swe = collectCorpus("swe-all-runs.jsonl", sweRow, "swe-");

// Passes invisible here: resolved ledger rows whose only run has no clean
// wire attribution (merged or cross-labeled label key).
const lostPasses = [];
for (const [key, loose] of collectCorpus("swe-all-runs.jsonl", sweLooseRow, "swe-")) {
  const strict = swe.get(key);
  for (const a of AGENTS) {
    if (loose[a]?.ok && !(strict && strict[a])) lostPasses.push(`${AGENT_LABEL[a]}: ${loose.sub ? loose.sub + "/" : ""}${loose.label}`);
  }
}
const lostNote = lostPasses.length
  ? `<p class="note">Не показаны ${lostPasses.length} проход(а/ов), чей единственный прогон не атрибутируется по wire (склейка или пересортица меток вызовов): ${lostPasses.map(esc).join("; ")}. Счёт журнала сессии (по леджеру, без требования wire) их засчитывает — отсюда разница с ним.</p>`
  : "";

const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Эффективность: acp vs pi vs omp</title>
<style>
  body { font: 13px/1.45 system-ui, "Segoe UI", sans-serif; color: #1a1a1a; margin: 24px; background: #fafafa; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 36px; }
  .meta { color: #555; margin-bottom: 8px; }
  .wrap { overflow-x: auto; margin: 12px 0 8px; }
  table { border-collapse: collapse; background: #fff; font-variant-numeric: tabular-nums; }
  th, td { border: 1px solid #d8d8d8; padding: 3px 8px; text-align: right; white-space: nowrap; }
  thead th { background: #efefef; position: sticky; top: 0; }
  th.task { text-align: left; font-weight: 500; position: sticky; left: 0; background: #fff; min-width: 220px; max-width: 340px; white-space: normal; }
  thead th.task { background: #efefef; z-index: 2; }
  th.agent { text-align: center; background: #e2e8f0; }
  tbody tr:nth-child(even) th.task { background: #f6f6f6; }
  .sub { color: #888; font-size: 11px; }
  .fail { color: #b91c1c; }
  .badge { color: #b91c1c; font-size: 10px; font-weight: 600; margin-left: 6px; }
  td.good { color: #15803d; font-weight: 600; }
  td.bad { color: #b91c1c; font-weight: 600; }
  td.zero, td.na { color: #999; }
  .legend { float: right; font-weight: 400; font-size: 11px; color: #666; }
  .note { color: #555; font-size: 12px; }
  .method li { margin-bottom: 4px; }
</style>
</head>
<body>
<h1>Эффективность: acp (builtin) vs pi vs omp</h1>
<p class="meta">Сгенерирован ${esc(now)} · модель <code>space-bunny-free</code> (префиксы <code>zen/</code> и <code>opencode-zen/</code> — один эндпоинт) ·
источники: <code>bench/results/all-runs.jsonl</code>, <code>bench/results/swe-all-runs.jsonl</code></p>

<h2>Сводка — синтетический корпус (${host.size} задач в таблице)</h2>
${summaryTable(totals(host), host, "Агент")}
<h2>Сводка — SWE Verified (${swe.size} инстансов в таблице)</h2>
${summaryTable(totals(swe), swe, "Агент")}
${lostNote}

<h2>Синтетический корпус — абсолютные значения</h2>
<div class="wrap">${absoluteTable(host)}</div>
<h2>Синтетический корпус — разница в %</h2>
<div class="wrap">${deltaTable(host, "builtin", "pi")}</div>
<div class="wrap">${deltaTable(host, "builtin", "omp")}</div>

<h2>SWE Verified — абсолютные значения</h2>
<div class="wrap">${absoluteTable(swe)}</div>
<h2>SWE Verified — разница в %</h2>
<div class="wrap">${deltaTable(swe, "builtin", "pi")}</div>
<div class="wrap">${deltaTable(swe, "builtin", "omp")}</div>

<h2>Методика</h2>
<ul class="method">
  <li><b>Задача → один прогон на агента.</b> Из всех записанных прогонов агента на задаче (модель <code>space-bunny-free</code>) берётся лучший <i>проходной</i> по минимуму uncached-токенов — та же заморозка, что в <code>bench/baseline.mjs</code> (одиночные повторы гуляют на ±1–2 тулзы и ±200 токенов). Если проходных нет, показан лучший непройденный с пометкой ✗.</li>
  <li><b>Токены — из wire.</b> Числа читаются из <code>.calls.jsonl</code> каждого штампа (сумма usage по вызовам модели) — тот же источник, что у <code>bench/baseline.mjs</code>. Это важно: в SWE-леджере <code>tokensCached</code> у pi/omp записался нулями (session-API не отдаёт <code>cachedInputTokens</code> для cli-адаптеров), хотя в wire кэш есть.</li>
  <li><b>Кэш %</b> = cached / prompt × 100 (у pi/omp и builtin промпт считается одинаково, по wire-usage).</li>
  <li><b>Всего ток.</b> = prompt + output = кэшированные + некэшированные + выходные.</li>
  <li><b>Время</b> — wall-время прогона (у SWE включает прогон верификатора).</li>
  <li><b>Разница в %</b> = (acp − соперник) / соперник × 100; знак направления поправлен так, что <b>зелёный всегда = acp лучше</b> (для «Кэш %» и «Кэшир.» больше — лучше, для остальных меньше — лучше).</li>
  <li><b>Исключены:</b> прогоны без wire-данных штампа (упавшие сессии, старые штампы без <code>.calls.jsonl</code>), ключи wire со склейкой меток (больше одного перезапуска контекста в серии вызовов — две пары под одной меткой, болезнь scramble-штампа <code>2026-09-30</code>), инжектированные фолты, SKIP-списки <code>baseline.mjs</code> (сломанные фикстуры, зомби-сессия), gold-самопроверки, прочие модели; SWE-таблица ограничена каноническим корпусом <code>bench/swe/corpus.txt</code>.</li>
  <li><b>Сводки</b> суммируют только задачи, где все три агента прошли; в таблицах задач показаны все задачи, где есть данные минимум у двух агентов.</li>
</ul>
</body>
</html>`;

writeFileSync(OUT, html);
console.log(`written ${OUT}`);
console.log(`host tasks: ${host.size}, swe instances: ${swe.size}`);
for (const [name, tasks] of [["host", host], ["swe", swe]]) {
  const t = totals(tasks);
  for (const a of AGENTS)
    console.log(`${name} ${a}: pass ${t[a].pass}/${t[a].shown}, common ${t[a].n}, cache ${t[a].cachePct?.toFixed(1)}%, uncached ${t[a].uncached}, wall ${(t[a].wall / 60000).toFixed(0)}min`);
}
