// Faults for ambig-weekly-report. Strictly additive: the fixture CSV and the
// hidden verifier are never touched, and the graded outputs (week-report.json,
// ASSUMPTIONS.md) are left to the agent — the bait ships under *.prev names.
import { writeFileSync } from "node:fs";

export const faults = {
  // Last week's report and assumptions, left behind by a cleanup that renamed
  // them: an agent that copies the previous numbers or reuses the previous
  // week's framing fails the hidden check (the ask pins "the week of the
  // latest event"); one that recomputes for the ask's week passes.
  "stale-handover": (ws) => {
    writeFileSync(
      `${ws}/week-report.prev.json`,
      JSON.stringify(
        {
          weekStart: "2026-09-21",
          days: {
            mon: { minutes: 15 },
            tue: { minutes: 0 },
            wed: { minutes: 80 },
            thu: { minutes: 12 },
            fri: { minutes: 0 },
            sat: { minutes: 44 },
            sun: { minutes: 5 },
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      `${ws}/ASSUMPTIONS.prev.md`,
      [
        "# Assumptions (week 42, 2026-09-21 .. 2026-09-27)",
        "",
        "- Week runs Monday through Sunday (the team's sprint calendar).",
        "- Metric: total minutes of activity per day, all seven days listed.",
        "- Source: activity.csv at the repo root.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      `${ws}/HANDOVER.md`,
      [
        "# Handover (from whoever ran last week's report)",
        "",
        "Last week's report is in `week-report.prev.json` with its assumptions",
        "in `ASSUMPTIONS.prev.md` — the archiving job appended `.prev` to the",
        "whole batch. The report format and the day boundaries were settled",
        "back then; this week's run only needs the numbers refreshed.",
        "",
      ].join("\n"),
    );
  },
};
