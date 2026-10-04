// Hidden verifier for long-analytics-pipeline.
// Re-runs the pipeline the agent wrote, then recomputes everything from the
// CSVs with an independent parser and compares. SPEC.md is the contract; the
// expected aggregates below were derived from it, not from the fixture.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync("pipeline/run.mjs")) fail("pipeline/run.mjs is missing");
const run = spawnSync(process.execPath, ["pipeline/run.mjs"], { encoding: "utf8" });
if (run.status !== 0 || run.error) fail(`node pipeline/run.mjs exits ${run.status ?? run.error}:\n${String(run.stdout + run.stderr).slice(-600)}`);
if (!existsSync("out/report.json")) fail("out/report.json was not produced");
if (!existsSync("out/summary.md")) fail("out/summary.md was not produced");

// --- independent reader -----------------------------------------------------
function* cells(text) {
  // RFC-4180 subset: quoted fields with commas, CRLF or LF rows, BOM tolerated.
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
  for (const r of rows) if (r.length > 1 || (r[0] ?? "").trim() !== "") yield r;
}

const EXPECT_FILES = ["events-01.csv", "events-02.csv", "events-03.csv", "events-04.csv", "events-05.csv"];
const seen = new Set();
let rowsRead = 0;
const kept = [];
for (const file of readdirSync("events").sort()) {
  if (!file.endsWith(".csv")) continue;
  seen.add(file);
  const lines = [...cells(readFileSync(`events/${file}`, "utf8"))];
  for (const cols of lines.slice(1)) {
    rowsRead += 1;
    const [id, ts, user, action, minutes] = cols;
    const ms = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
    const okTs = Number.isFinite(ms);
    const okMinutes = /^\d+$/.test(minutes ?? "");
    if (!id || !okTs || !user || !action || !okMinutes) continue;
    if (kept.some((r) => r.id === id)) continue; // first id wins
    kept.push({ id, day: new Date(ms).toISOString().slice(0, 10), user, minutes: Number(minutes) });
  }
}
if (seen.size !== EXPECT_FILES.length) fail(`expected events files missing: ${EXPECT_FILES.filter((f) => !seen.has(f)).join(", ")}`);

const byDay = {};
const byUser = {};
let total = 0;
for (const r of kept) {
  (byDay[r.day] ??= { events: 0, minutes: 0 });
  byDay[r.day].events += 1;
  byDay[r.day].minutes += r.minutes;
  (byUser[r.user] ??= { events: 0, minutes: 0 });
  byUser[r.user].events += 1;
  byUser[r.user].minutes += r.minutes;
  total += r.minutes;
}
const topUsers = Object.entries(byUser)
  .map(([user, v]) => ({ user, minutes: v.minutes }))
  .sort((a, b) => b.minutes - a.minutes || (a.user < b.user ? -1 : 1))
  .slice(0, 3);

const expected = {
  files: EXPECT_FILES,
  rowsRead,
  rowsKept: kept.length,
  rowsSkipped: rowsRead - kept.length,
  byDay,
  byUser,
  topUsers,
};
// Key-order-insensitive deep compare (agents emit maps sorted or unsorted —
// JSON objects are unordered; the VALUES are the contract).
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
      : v;
const actual = JSON.parse(readFileSync("out/report.json", "utf8"));
for (const key of Object.keys(expected)) {
  const a = JSON.stringify(stable(actual[key]));
  const b = JSON.stringify(stable(expected[key]));
  if (a !== b) fail(`report.json.${key}: got ${a?.slice(0, 400)}, want ${b?.slice(0, 400)}`);
}

const summary = readFileSync("out/summary.md", "utf8");
const want = [
  /^# Ingest summary$/m,
  new RegExp(`^kept ${kept.length} of ${rowsRead} rows \\(${rowsRead - kept.length} skipped\\)$`, "m"),
  new RegExp(`^Total minutes: ${total}$`, "m"),
  new RegExp(`^Top user: ${topUsers[0].user.replace(/[,\\]/g, "\\$&")} \\(${topUsers[0].minutes} minutes\\)$`, "m"),
];
for (const re of want) if (!re.test(summary)) fail(`summary.md does not match ${re}`);

console.log(`PASS: report matches the independent recount (${rowsRead} read, ${kept.length} kept), summary numbers OK`);
