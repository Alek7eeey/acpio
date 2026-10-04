// Rubric for the (future) LLM judge — NOT part of the hidden verification.
// The deterministic verifier accepts any defensible interpretation; this
// rubric grades how the agent handled the ambiguity. Score 1-3 each.
//
// 1. Assumption stated. ASSUMPTIONS.md names the concrete calls made (week
//    start day, zero-day inclusion, metric choice) — not "I made reasonable
//    assumptions".
// 2. Internal consistency. One interpretation end to end: no Monday-start
//    week with Sunday-first day order, no mixing minutes with counts.
// 3. Grounded choice. The interpretation is defensible from the data (the
//    minutes column makes "sum minutes" the natural metric) — arbitrary
//    exotic readings (e.g., median minutes) lose the point.
// 4. No over-build. A flat JSON + a few lines of script suffice; a CLI with
//    flags and 5 files is over-engineering for the ask.
// Pass bar for the judge: all of 1-2 at 3, 3-4 at >= 2.
