// Ingest pipeline per SPEC.md: read events/events-*.csv (sorted), keep valid
// rows (first id wins), aggregate by UTC day and user, write out/report.json
// and out/summary.md. Node standard library only.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

function parseCsv(text) {
  const rows = [[]];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      rows.at(-1).push(field);
      field = "";
    } else if (c === "\n") {
      rows.at(-1).push(field.replace(/\r$/, ""));
      field = "";
      rows.push([]);
    } else field += c;
  }
  rows.at(-1).push(field);
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

function tsToDay(ts) {
  if (/^\d+$/.test(ts)) return new Date(Number(ts)).toISOString().slice(0, 10);
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

const files = readdirSync("events").filter((f) => f.endsWith(".csv")).sort();
const kept = [];
const seenIds = new Set();
let rowsRead = 0;

for (const file of files) {
  const lines = parseCsv(readFileSync(`events/${file}`, "utf8"));
  for (const cols of lines.slice(1)) {
    rowsRead += 1;
    const [id, ts, user, action, minutes] = cols;
    const day = id && ts ? tsToDay(ts) : null;
    if (!id || !day || !user || !action || !/^\d+$/.test(minutes ?? "")) continue;
    if (seenIds.has(id)) continue; // first occurrence wins
    seenIds.add(id);
    kept.push({ day, user, minutes: Number(minutes) });
  }
}

const byDay = {};
const byUser = {};
let totalMinutes = 0;
for (const r of kept) {
  const d = (byDay[r.day] ??= { events: 0, minutes: 0 });
  d.events += 1;
  d.minutes += r.minutes;
  const u = (byUser[r.user] ??= { events: 0, minutes: 0 });
  u.events += 1;
  u.minutes += r.minutes;
  totalMinutes += r.minutes;
}
const topUsers = Object.entries(byUser)
  .map(([user, v]) => ({ user, minutes: v.minutes }))
  .sort((a, b) => b.minutes - a.minutes || (a.user < b.user ? -1 : 1))
  .slice(0, 3);

const report = {
  files,
  rowsRead,
  rowsKept: kept.length,
  rowsSkipped: rowsRead - kept.length,
  byDay,
  byUser,
  topUsers,
};

mkdirSync("out", { recursive: true });
writeFileSync("out/report.json", JSON.stringify(report, null, 2) + "\n");
writeFileSync(
  "out/summary.md",
  [
    "# Ingest summary",
    `kept ${report.rowsKept} of ${report.rowsRead} rows (${report.rowsSkipped} skipped)`,
    `Total minutes: ${totalMinutes}`,
    `Top user: ${topUsers[0].user} (${topUsers[0].minutes} minutes)`,
    "",
  ].join("\n"),
);
console.log(`wrote out/report.json and out/summary.md (${report.rowsKept}/${report.rowsRead} rows kept)`);
