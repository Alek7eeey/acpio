# Release history

One row per release, newest first. A release is a `v<major>.<minor>.<patch>` git
tag — the release run pushes it (`.github/workflows/release.yml`) and npm holds
these same numbers, so this table lists the versions that were actually published
instead of every commit day.

The next release is one patch above the highest tag reachable from the revision;
a tagged revision reports its own tag (`scripts/releaseTags.mjs`). Tags live in
git, so the number needs no network and reads the same on every machine.

Release dates use `DD.MM.YY` (author date of the tagged commit).

| Version | Released |
|---------|----------|
| 0.1.39 | 20.10.26 |
| 0.1.38 | 17.10.26 |
