#!/usr/bin/env node
/**
 * Cache-rate timeline for one chat, out of the wire log.
 *
 * Reads `data/wire-log/<session>.jsonl` (and the request bodies beside it) and
 * writes a self-contained page: every model call in time order, its input size
 * against the compaction line, its cached share, and — for each miss — what the
 * payload said the cause was (a shrunken view of ours, a compaction, a cold
 * start, or an identical prefix the provider simply did not match).
 *
 * Usage: node scripts/cache-timeline.mjs <sessionId|wireLogId> [out.html]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const here = process.cwd();
const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/cache-timeline.mjs <sessionId|wireLogId> [out.html]");
  process.exit(1);
}

/** The wire log names its file after the first 8 chars of the ACP session id. */
function wireId(id) {
  for (const candidate of [id, id.slice(0, 8)]) {
    if (fs.existsSync(path.join(here, "data", "wire-log", `${candidate}.jsonl`))) return candidate;
  }
  const dbPath = path.join(here, "data", "acpio.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("select acp_session_id from sessions where id = ?").get(id);
    db.close();
    const acp = row?.acp_session_id ? String(row.acp_session_id) : null;
    for (const candidate of acp ? [acp, acp.slice(0, 8)] : []) {
      if (fs.existsSync(path.join(here, "data", "wire-log", `${candidate}.jsonl`))) return candidate;
    }
  } catch {
    /* no sqlite: the id has to be the wire id itself */
  }
  return null;
}

const id = wireId(arg);
if (!id) {
  console.error(`no wire log for ${arg}`);
  process.exit(1);
}

const logPath = path.join(here, "data", "wire-log", `${id}.jsonl`);
const bodyDir = path.join(here, "data", "wire-log", id);
const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const bodies = new Map();
function bodyOf(file) {
  if (!file) return null;
  if (!bodies.has(file)) {
    try {
      bodies.set(file, JSON.parse(fs.readFileSync(path.join(here, "data", "wire-log", file), "utf8")));
    } catch {
      bodies.set(file, null);
    }
  }
  return bodies.get(file);
}

/** Tokens the payload holds, by our own chars/4 estimate — for "what was dropped". */
const est = (messages) => Math.round(JSON.stringify(messages).length / 4);

let settings = {};
try {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(here, "data", "acpio.db"), { readonly: true, fileMustExist: true });
  const row = db.prepare("select value from settings where key = 'app'").get();
  settings = row ? JSON.parse(row.value) : {};
  db.close();
} catch {
  /* the page works without the settings: the line falls back to 200K */
}
const windowTokens = settings.builtinProviders?.[0]?.models?.[0]?.contextWindow ?? 1_000_000;
const line = Math.round((windowTokens * (settings.builtinCompactionThresholdPercent ?? 20)) / 100);

/** A colour per cause, so "ours" and "the provider's" never read alike. */
const CAUSE_COLOR = {
  "наш подрез вида": "#ff3b30",
  "промах провайдера": "#19d3c5",
  "сжатие (compaction)": "#c678dd",
  "холодный старт": "#8b95a7",
  "смена префикса": "#ffd23f",
};
const colorOf = (cause) => CAUSE_COLOR[cause] ?? "#ff5c4d";

const rows = [];
let req = null;
let prev = null;
let prevBody = null;
for (const entry of lines) {
  if (entry.kind === "request") {
    req = entry;
    continue;
  }
  if (!entry.usage?.input) continue;
  const body = bodyOf(req?.bodyFile);
  const messages = body?.messages ?? null;
  let imgs = 0;
  if (body) imgs = JSON.stringify(body).split("image_url").length - 1;

  // What the view shares with the previous call, and what the cut threw away.
  let commonPrefix = null;
  let cutAt = null;
  let droppedTokens = null;
  if (messages && prevBody?.messages) {
    const before = prevBody.messages;
    let k = 0;
    while (k < Math.min(before.length, messages.length) && JSON.stringify(before[k]) === JSON.stringify(messages[k])) k++;
    commonPrefix = k;
    if (k < before.length) {
      const kept = new Set(messages.map((m) => JSON.stringify(m)));
      cutAt = k;
      droppedTokens = est(before.filter((m) => !kept.has(JSON.stringify(m))));
    }
  }

  const row = {
    ts: entry.ts,
    input: entry.usage.input,
    cached: entry.usage.cached ?? 0,
    output: entry.usage.output ?? 0,
    pct: entry.usage.input > 0 ? Math.round(((entry.usage.cached ?? 0) / entry.usage.input) * 100) : 0,
    msgs: messages?.length ?? req?.messages ?? null,
    prefixSame: req?.prefixSame ?? null,
    bodyBytes: req?.bodyBytes ?? null,
    imgs,
    commonPrefix,
    cutAt,
    droppedTokens,
    systemChanged: !!req?.systemChanged,
    toolsChanged: !!req?.toolsChanged,
    seq: entry.seq,
  };
  const gapMin = prev ? (Date.parse(entry.ts) - Date.parse(prev.ts)) / 60000 : null;
  const note = messages && messages[1]?.content && JSON.stringify(messages[1].content).includes("earlier steps of this turn were dropped");
  row.viewCut = note;
  // A miss is a call that paid for most of its input. The cause is read off the
  // payload, not guessed: a view of ours that lost its head, a compaction that
  // rebuilt the transcript, a cold start, or a provider that did not match a
  // prefix it had already seen.
  if (row.pct < 50) {
    if (!prev || (gapMin ?? 0) > 30) row.cause = "холодный старт";
    else if (row.viewCut && (row.prefixSame ?? 99) < 5) row.cause = "наш подрез вида";
    else if (prev.msgs != null && row.msgs != null && row.msgs < prev.msgs - 5) row.cause = "сжатие (compaction)";
    else if ((row.commonPrefix ?? 0) >= (prev.msgs ?? 0) * 0.85) row.cause = "промах провайдера";
    else row.cause = "смена префикса";
  }
  rows.push(row);
  prev = row;
  prevBody = body;
}

const totalIn = rows.reduce((s, r) => s + r.input, 0);
const totalCached = rows.reduce((s, r) => s + r.cached, 0);
const misses = rows.filter((r) => r.pct < 50);
const byCause = {};
for (const m of misses) {
  const c = (byCause[m.cause] ??= { n: 0, input: 0, cached: 0 });
  c.n += 1;
  c.input += m.input;
  c.cached += m.cached;
}

const t0 = Date.parse(rows[0].ts);
const t1 = Date.parse(rows[rows.length - 1].ts);
const at = (ts) => (Date.parse(ts) - t0) / 1000;
const span = Math.max(1, at(rows[rows.length - 1].ts));
const fmt = (n) => n.toLocaleString("ru-RU").replace(/\u00a0/g, " ");
const clock = (ts) => new Date(ts).toISOString().slice(11, 19);
const dateOf = (ts) => new Date(ts).toISOString().slice(0, 10);

const data = {
  id,
  windowTokens,
  line,
  span,
  start: rows[0].ts,
  totalIn,
  totalCached,
  rows: rows.map((r) => ({
    ...r,
    t: at(r.ts),
  })),
};

const out = process.argv[3] ?? path.join(here, "diagnostics", `cache-timeline-${id}.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page(data), "utf8");
console.log(out);
console.log(`запросов ${rows.length}, вход ${fmt(totalIn)}, в кэше ${Math.round((totalCached / totalIn) * 100)}%, промахов ${misses.length}`);
for (const [c, v] of Object.entries(byCause)) console.log(`  ${c}: ${v.n} запр., ${fmt(v.input)} токенов, недоплачено ${fmt(v.input - v.cached)}`);

function page(data) {
  const R = data.rows;
  const W = 1180;
  const H = 330;
  const padL = 62;
  const padR = 96;
  const padT = 16;
  const padB = 34;
  const x = (t) => padL + ((W - padL - padR) * t) / data.span;
  const yMax = Math.max(data.line * 1.25, ...R.map((r) => r.input));
  const yIn = (v) => padT + (H - padT - padB) * (1 - v / yMax);
  // A long pause is not a straight line on the chart: break the series there,
  // otherwise a 70-minute gap reads as a slow slide of the input size.
  const runs = [];
  let run = [];
  for (let i = 0; i < R.length; i++) {
    if (i > 0 && R[i].t - R[i - 1].t > 600) {
      runs.push(run);
      run = [];
    }
    run.push(R[i]);
  }
  if (run.length) runs.push(run);
  const pathOf = (fn) =>
    runs
      .map((seg) => seg.map((r, i) => `${i ? "L" : "M"}${x(r.t).toFixed(1)},${fn(r).toFixed(1)}`).join(" "))
      .join(" ");
  const yPct = (v) => padT + (H - padT - padB) * (1 - v / 100);

  const linePath = pathOf((r) => yIn(r.input));
  const missDots = R.filter((r) => r.pct < 50)
    .map(
      (r) =>
        `<circle cx="${x(r.t).toFixed(1)}" cy="${yIn(r.input).toFixed(1)}" r="6.5" fill="${colorOf(r.cause)}" stroke="#0f1115" stroke-width="2"><title>${clock(r.ts)} · ${r.cause}\nвход ${r.input}, в кэше ${r.cached} (${r.pct}%)\nсообщений ${r.msgs}${r.cutAt != null ? `, подрез с №${r.cutAt}, выкинуто ~${r.droppedTokens} ток.` : ""}</title></circle>`,
    )
    .join("");
  const missDotsPct = R.filter((r) => r.pct < 50)
    .map(
      (r) =>
        `<circle cx="${x(r.t).toFixed(1)}" cy="${yPct(r.pct).toFixed(1)}" r="4.5" fill="${colorOf(r.cause)}" stroke="#0f1115" stroke-width="1.5"><title>${clock(r.ts)} · ${r.cause} · кэш ${r.pct}%</title></circle>`,
    )
    .join("");
  const dots = R.filter((r) => r.pct >= 50)
    .map(
      (r) =>
        `<circle class="hit" cx="${x(r.t).toFixed(1)}" cy="${yIn(r.input).toFixed(1)}" r="2.2"><title>${clock(r.ts)} · вход ${r.input}, кэш ${r.pct}%</title></circle>`,
    )
    .join("");
  const pctPath = pathOf((r) => yPct(r.pct));

  // One vertical guide per miss, so the two charts read together.
  const guides = R.filter((r) => r.pct < 50)
    .map((r) => `<line x1="${x(r.t).toFixed(1)}" y1="${padT}" x2="${x(r.t).toFixed(1)}" y2="${H - padB}" stroke="${colorOf(r.cause)}" stroke-width="1" stroke-dasharray="2 4" opacity="0.4"></line>`)
    .join("");

  const ticks = [];
  const stepH = data.span > 3 * 3600 ? 3600 : data.span > 3600 ? 900 : 300;
  for (let s = 0; s <= data.span; s += stepH) {
    const ts = new Date(Date.parse(data.start) + s * 1000).toISOString();
    ticks.push(
      `<line class="grid" x1="${x(s).toFixed(1)}" y1="${padT}" x2="${x(s).toFixed(1)}" y2="${H - padB}"></line>
       <text class="axis" x="${x(s).toFixed(1)}" y="${H - padB + 16}" text-anchor="middle">${ts.slice(11, 16)}</text>`,
    );
  }

  const tableRows = R.filter((r) => r.pct < 50 || r.cutAt != null)
    .map(
      (r) => `<tr>
      <td class="mono">${dateOf(r.ts)} ${clock(r.ts)}</td>
      <td>${r.cause ? `<span class="cause" style="--c:${colorOf(r.cause)}"><i></i>${r.cause}</span>` : "—"}</td>
      <td class="num">${fmt(r.input)}</td>
      <td class="num">${fmt(r.cached)}</td>
      <td class="num">${r.pct}%</td>
      <td class="num">${r.msgs ?? "—"}</td>
      <td class="num">${r.prefixSame ?? "—"}</td>
      <td class="num">${r.cutAt ?? "—"}</td>
      <td class="num">${r.droppedTokens ?? "—"}</td>
      <td class="num">${r.imgs}</td>
    </tr>`,
    )
    .join("");

  const causeCards = Object.entries(
    R.filter((r) => r.pct < 50).reduce((acc, r) => {
      const c = (acc[r.cause] ??= { n: 0, input: 0, cached: 0 });
      c.n += 1;
      c.input += r.input;
      c.cached += r.cached;
      return acc;
    }, {}),
  )
    .map(
      ([c, v]) => `<div class="card" style="border-left:3px solid ${colorOf(c)}"><div class="k">${c}</div>
        <div class="v">${v.n} запр. · ${fmt(v.input)} ток. · кэш ${Math.round((v.cached / v.input) * 100)}%</div>
        <div class="s">недоплачено ${fmt(v.input - v.cached)}</div></div>`,
    )
    .join("");

  const legendCauses = [...new Set(R.filter((r) => r.pct < 50).map((r) => r.cause))]
    .map((c) => `<span><i style="background:${colorOf(c)}"></i>${c}</span>`)
    .join("");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Кэш-таймлайн ${data.id}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 28px 60px; background: #0f1115; color: #d7dce5;
         font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: #8b95a7; font-size: 13px; margin-bottom: 18px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
  .card { background: #161a21; border: 1px solid #232a35; border-radius: 8px; padding: 10px 13px; min-width: 190px; }
  .card .k { font-size: 12px; color: #8b95a7; }
  .card .v { font-size: 14px; margin: 2px 0; }
  .card .s { font-size: 12px; color: #e0765a; }
  .panel { background: #12151b; border: 1px solid #1f2530; border-radius: 10px; padding: 10px 12px 4px; margin-bottom: 16px; }
  .panel h2 { font-size: 13px; font-weight: 600; color: #9aa5b8; margin: 2px 0 6px; }
  svg { display: block; width: 100%; height: auto; }
  .axis { fill: #6d7789; font-size: 11px; }
  .grid { stroke: #1d232d; stroke-width: 1; }
  .guide { stroke: #e0564a; stroke-width: 1; stroke-dasharray: 2 4; opacity: .35; }
  .hit { fill: #4f8ef7; opacity: .55; }
  .cause { display: inline-flex; align-items: center; gap: 6px; }
  .cause i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); display: inline-block; }
  .cause { color: #c7cedb; }
  .inpath { fill: none; stroke: #4f8ef7; stroke-width: 1.6; }
  .pctpath { fill: none; stroke: #3fbf7f; stroke-width: 1.6; }
  .lim { stroke: #c9a227; stroke-width: 1; stroke-dasharray: 6 5; }
  .band { fill: #c9a227; opacity: .07; }
  .limtxt { fill: #c9a227; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1c222c; }
  th { color: #8b95a7; font-weight: 600; font-size: 12px; position: sticky; top: 0; background: #12151b; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono { font-family: ui-monospace, Consolas, monospace; color: #9aa5b8; }
  tr.bad td { color: #ffb4a8; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: #8b95a7; margin: 6px 0 2px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
</style></head><body>
<h1>Кэш-таймлайн: ${data.id}</h1>
<div class="sub">${data.rows.length} вызовов модели · линия сжатия ${fmt(data.line)} токенов (${Math.round((data.line / data.windowTokens) * 100)}% от окна ${fmt(data.windowTokens)}) · вход ${fmt(data.totalIn)} · в кэше ${Math.round((data.totalCached / data.totalIn) * 100)}%</div>
<div class="cards">${causeCards}</div>

<div class="panel"><h2>Размер входа по времени, точка = вызов модели</h2>
<div class="legend"><span><i style="background:#4f8ef7"></i>в кэше ≥50%</span>${legendCauses}<span><i style="background:#c9a227"></i>линия ${fmt(data.line)} ±5%</span></div>
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
  ${ticks.join("")}
  <rect class="band" x="${padL}" y="${yIn(data.line * 1.05).toFixed(1)}" width="${W - padL - padR}" height="${(yIn(data.line * 0.95) - yIn(data.line * 1.05)).toFixed(1)}"></rect>
  ${[0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(yMax * f);
    return `<line class="grid" x1="${padL}" y1="${yIn(v).toFixed(1)}" x2="${W - padR}" y2="${yIn(v).toFixed(1)}"></line>
      <text class="axis" x="${padL - 8}" y="${(yIn(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v / 1000)}K</text>`;
  }).join("")}
  <line class="lim" x1="${padL}" y1="${yIn(data.line).toFixed(1)}" x2="${W - padR}" y2="${yIn(data.line).toFixed(1)}"></line>
  <text class="limtxt" x="${W - padR + 6}" y="${(yIn(data.line) + 4).toFixed(1)}">${fmt(data.line)}</text>
  ${guides}
  <path class="inpath" d="${linePath}"></path>
  ${dots}${missDots}
  <text class="axis" x="${padL}" y="${H - 6}">${clock(data.start)}</text>
</svg></div>

<div class="panel"><h2>Доля кэша на каждом вызове, % — точки промахов окрашены по причине</h2>
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
  ${ticks.join("")}
  ${[0, 25, 50, 75, 100].map((v) => `<line class="grid" x1="${padL}" y1="${yPct(v).toFixed(1)}" x2="${W - padR}" y2="${yPct(v).toFixed(1)}"></line>
    <text class="axis" x="${padL - 8}" y="${(yPct(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join("")}
  ${guides}
  <path class="pctpath" d="${pctPath}"></path>
  ${missDotsPct}
</svg></div>

<div class="panel"><h2>Подрезы вида и промахи</h2>
<table><thead><tr>
  <th>время</th><th>причина</th><th class="num">вход</th><th class="num">в кэше</th><th class="num">%</th>
  <th class="num">сообщ.</th><th class="num">prefixSame</th><th class="num">подрез с №</th><th class="num">выкинуто</th><th class="num">картинок</th>
</tr></thead><tbody>${tableRows}</tbody></table>
<p class="sub">Выкинуто — оценка токенов (chars/4) того, что исчезло из полезной нагрузки. prefixSame — сколько сообщений совпало с предыдущим запросом: 1–2 значит, что вид потерял голову и весь промпт ушёл заново.</p>
</div>
</body></html>`;
}
