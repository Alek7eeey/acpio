// Hidden verifier for ambig-weekly-report. The ask is genuinely ambiguous, so
// the verifier accepts ANY defensible interpretation of "activity grouped by
// day of week": week starting Monday or Sunday, all seven days or only days
// with events, minutes summed or events counted — under any reasonable field
// naming (the ask did not pin an envelope). What it requires: the numbers
// must be RIGHT for one interpretation, in one consistent week, with
// assumptions written down (ASSUMPTIONS.md).
import { readFileSync, existsSync } from "node:fs";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync("ASSUMPTIONS.md")) fail("ASSUMPTIONS.md is missing — the ask leaves choices open, write down the ones you made");
if (!readFileSync("ASSUMPTIONS.md", "utf8").trim()) fail("ASSUMPTIONS.md is empty");
if (!existsSync("week-report.json")) fail("week-report.json is missing");

const rows = readFileSync("activity.csv", "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => {
    const [id, ts, minutes] = l.split(",");
    return { id, ts, minutes: Number(minutes) };
  });

const DAY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_TOKEN = (s) => {
  const t = String(s).toLowerCase();
  const i = DAY_INDEX.findIndex((d) => t.startsWith(d));
  return i >= 0 ? DAY_INDEX[i] : null;
};
const weekdayOf = (date) => DAY_TOKEN(DAY_INDEX[new Date(date + "T00:00:00Z").getUTCDay()]);

// Pull a (dayToken, minutesValue, eventsValue) triple out of one entry under
// any reasonable naming.
function entry(d) {
  if (!d || typeof d !== "object") return null;
  const token = DAY_TOKEN(d.day ?? d.day_of_week ?? d.dayOfWeek ?? d.weekday ?? "")
    ?? (d.date ? weekdayOf(d.date) : null);
  if (!token) return null;
  return {
    token,
    minutes: d.minutes ?? d.total_minutes ?? d.minute ?? null,
    events: d.events ?? d.event_count ?? d.count ?? null,
  };
}

// The report body: a day-entry list anywhere reasonable — root array, array
// under common keys, one level of wrapper object (e.g. { week: { days } }), or
// an object keyed by day name / date.
function entriesOf(report) {
  const fromList = (list) => list.map(entry).filter(Boolean);
  const fromKeyed = (obj) =>
    Object.entries(obj).map(([k, v]) => (v && typeof v === "object" ? entry({ ...v, day: v.day ?? (DAY_TOKEN(k) ? k : null), date: v.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null) }) : null)).filter(Boolean);
  if (Array.isArray(report)) {
    const e = fromList(report);
    if (e.length) return e;
  }
  for (const key of ["days", "report", "week", "byDay", "by_day", "activity"]) {
    const v = report?.[key];
    if (Array.isArray(v)) {
      const e = fromList(v);
      if (e.length) return e;
    }
    if (v && typeof v === "object" && Array.isArray(v.days)) {
      const e = fromList(v.days);
      if (e.length) return e;
    }
  }
  for (const v of Object.values(report ?? {})) {
    if (Array.isArray(v)) {
      const e = fromList(v);
      if (e.length >= 3) return e;
    }
  }
  return fromKeyed(report ?? {});
}

const report = JSON.parse(readFileSync("week-report.json", "utf8"));
const got = entriesOf(report);
if (!got || !got.length) fail("week-report.json: no day entries found (array of day objects, a `days` list, or day/date-keyed object)");

// Enumerate every defensible interpretation; accept if the report matches one.
const candidates = [];
for (const start of ["mon", "sun"]) {
  const order = start === "mon" ? ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] : ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const begin = new Date((start === "mon" ? "2026-09-28" : "2026-09-27") + "T00:00:00Z").getTime();
  const inWeek = rows.filter((r) => {
    const t = new Date(r.ts).getTime();
    return t >= begin && t < begin + 7 * 86400_000;
  });
  for (const metric of ["minutes", "events"]) {
    for (const zeros of ["all", "present"]) {
      const expected = order
        .map((day, i) => {
          const dayStart = begin + i * 86400_000;
          const inDay = inWeek.filter((r) => {
            const t = new Date(r.ts).getTime();
            return t >= dayStart && t < dayStart + 86400_000;
          });
          return { token: day, minutes: inDay.reduce((n, r) => n + r.minutes, 0), events: inDay.length };
        })
        .filter((d) => zeros === "all" || (metric === "minutes" ? d.minutes : d.events) > 0);
      candidates.push({ interpretation: `week starts ${start}, ${metric}, ${zeros === "all" ? "all 7 days" : "only days present"}`, metric, expected });
    }
  }
}

const normGot = JSON.stringify(got.map((d) => d.token));
for (const c of candidates) {
  // The agent may store the metric under either field name; the candidate's
  // own metric defines the values, the field name is free.
  for (const field of ["minutes", "events"]) {
    const proj = got.map((d) => [d.token, d[field]]);
    if (proj.some(([, v]) => v == null)) continue;
    if (JSON.stringify(proj) === JSON.stringify(c.expected.map((d) => [d.token, d[c.metric]]))) {
      console.log(`PASS: numbers are right for a defensible interpretation (${c.interpretation})`);
      process.exit(0);
    }
  }
}
fail(`week-report.json matches no defensible interpretation.\ngot: ${normGot} (${JSON.stringify(got)})\none expected (of ${candidates.length}): ${JSON.stringify(candidates[0].expected.map((d) => [d.token, d.minutes, d.events]))}`);
