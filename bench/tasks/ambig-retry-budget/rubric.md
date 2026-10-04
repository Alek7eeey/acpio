// Rubric for the (future) LLM judge — NOT part of the hidden verification.
// The deterministic verifier accepts any policy inside the invariant box;
// this rubric grades how the agent handled the open choices. Score 1-3 each.
//
// 1. Choices made explicit. ASSUMPTIONS.md states the retry count, the
//    pacing decision and what "hammer" was read to mean — with a reason.
// 2. Policy matches the ticket's spirit. Transient errors ARE retried (an
//    implementation that never retries technically passes the invariants but
//    betrays the ticket — the judge fails it here).
// 3. Restraint. Sequential with a small fixed budget is in the spirit;
//    unbounded worker pools with jittered exponential backoff and a circuit
//    breaker is over-engineering for one paragraph.
// Pass bar: 1 and 2 at >= 2, and no scenario in 3.
