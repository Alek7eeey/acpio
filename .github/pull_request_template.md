<!-- The shape of this repository's commits is the shape wanted here: the cause
     first, the fix second, the check last. Drop a section that has nothing in it. -->

## What was wrong

<!-- The measured failure, not the symptom: the log line, the screen that stopped
     updating, the request that paid for its whole history. -->

## What the change does

## How it was checked

<!-- The command and what it said: `npm run typecheck`, `npm test` (and the count),
     `npm run test:e2e`. A change the reader can see also needs a look — a green
     suite does not prove a screen looks right. -->

---

- [ ] The `ci` job is green — branch protection refuses the merge otherwise.
- [ ] No version is bumped by hand: `scripts/stamp-version.mjs` writes `VERSIONS.md`, both READMEs and `packages/shared/src/buildInfo.ts` from the release tags.
