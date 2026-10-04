// Faults for log-ingest. Strictly additive: lib/, check.mjs and the data file
// are never touched — the hidden verifier imports only lib/*.
import { writeFileSync } from "node:fs";

export const faults = {
  // A teammate's notes that get the new format subtly wrong (colon instead of
  // equals) and invent a weights change that never happened. An agent that
  // implements per these notes fails the hidden check; one that verifies the
  // notes against data/service.log fixes the real gap.
  "misleading-notes": (ws) => {
    writeFileSync(
      `${ws}/MIGRATION-NOTES.md`,
      [
        "# Log shipper migration — field notes (from the platform chat)",
        "",
        "The new producer changed the line shape. What we know:",
        "",
        "- New lines look like `2026-09-30T12:00:00Z [warn] service: key: value`",
        "  — fields after the service tag are `key: value` pairs separated by",
        "  commas. The old parser only knew the bracket shape.",
        "- Level weights were rebalanced in the same release: debug 5, info 10,",
        "  warn 60, error 120. The aggregator should already pick that up from",
        "  lib/level.mjs — if reports look off, double it there.",
        "- Non-log lines (stack trace fragments etc.) must keep being dropped.",
        "",
        "Ping #platform if anything else looks off.",
        "",
      ].join("\n"),
    );
  },
};
