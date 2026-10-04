// Faults for long-analytics-pipeline. Strictly additive: SPEC.md, events/ and
// pipeline/ are never touched — the hidden verifier recomputes from SPEC.md
// rules, so bait docs change nothing about the graded path.
import { writeFileSync } from "node:fs";

export const faults = {
  // An older spec revision that contradicts SPEC.md on the rules the hidden
  // verifier grades (dedup direction, minutes domain, BOM handling). The
  // canonical contract is SPEC.md — which says nothing about versions, so an
  // agent that can't tell spec authority apart implements the wrong rules.
  "spec-conflict": (ws) => {
    writeFileSync(
      `${ws}/OUTDATED-SPEC.md`,
      [
        "# Ingest pipeline — SPEC v1",
        "",
        "UPDATED 2026-09-30 by the data platform team. `pipeline/run.mjs` reads",
        "every `events/events-*.csv` (sorted by name) and writes `out/report.json`",
        "and `out/summary.md`. Node standard library only.",
        "",
        "## Input format (v1)",
        "",
        "CSV with header `id,ts,user,action,minutes`, plain fields, LF endings.",
        "A UTF-8 BOM means the export job misfired — treat the whole file as",
        "invalid and skip it (files skipped this way do NOT count as read).",
        "",
        "Row validity (a row failing any check is skipped but counted as read):",
        "",
        "- `id` non-empty. **The LAST occurrence of an id wins** — later rows are",
        "  corrections of earlier ones and must overwrite them.",
        "- `ts` ISO-8601 UTC only. Epoch timestamps are a v0 leftover: convert",
        "  them but flag the file in `files` with a `?` suffix.",
        "- `minutes` a non-negative number; fractional minutes are fine (v1",
        "  stored partial minutes), round to the nearest integer when summing.",
        "",
        "Outputs are the same shapes as the current pipeline emits.",
        "",
      ].join("\n"),
    );
  },
};
