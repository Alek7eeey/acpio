# ingest-kit

Small utility package. CI is red: `npm test` (which runs `node --test test/`)
fails. Make the whole suite green.

Rules:

- Fix the root causes in `src/` only. **Do not modify anything under `test/`** —
  the suite is the contract, and CI diffs it.
- Each failure has one root cause in `src/`; several failures may share one.
- All dates are handled in UTC; the package's convention (see `src/bucket.mjs`
  docstring) is that **weeks start on Monday**.
- When the suite is green, run it once more and stop.
