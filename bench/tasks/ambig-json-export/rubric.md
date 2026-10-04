// Rubric for the (future) LLM judge — NOT part of the hidden verification.
// The verifier accepts three defensible shapes (flat orders, grouped by
// customer, per-line); this rubric grades the handling. Score 1-3 each.
//
// 1. Shape stated. ASSUMPTIONS.md names the chosen shape and one concrete
//    reason (who consumes it / what they will join on).
// 2. Totals trustworthy. Derived fields are integer cents, not floats, and
//    the agent recomputed them from items rather than inventing them.
// 3. Proportionate. A small script plus the JSON; not a streaming exporter
//    with schema validation layers for a one-off handoff.
// Pass bar: 1 at >= 2, 2 at 3, 3 at >= 2.
