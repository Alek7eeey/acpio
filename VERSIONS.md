# Release history

Patch version increases by 1 for each calendar day that has at least one git commit since the epoch (`versionEpoch` in `package.json`, default `2026-08-26`).

The number is taken from git history, so clones and local builds of the same revision show the same version. Local `npm run dev` / `npm run build` do not bump it.

Release dates use `DD.MM.YY` (author date of that day's commits).

| Version | Released |
|---------|----------|
| 0.1.1 | 27.08.26 |
| 0.1.0 | 26.08.26 |
