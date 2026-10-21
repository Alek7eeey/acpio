---
name: verify-bugfix
description: Method for a reported defect — the report is the spec, the cause is fixed once instead of each site where the symptom shows, and the check fails before the fix and passes after. Use for bug reports, failing tests, "works wrong", "it does X instead of Y"; not for new features or typos.
---

# Bugfix

A bug report is also a spec: every behavior it states must hold after the fix the way it held before. Where the wording is ambiguous, mirror what the unfixed code already did on that path — only the reported defect changes.

- Fix the cause, not the site where the symptom shows. When the issue's wording settles the expected behavior ("instead of"), that is a replacement, not an addition.
- Before you edit, grep every caller of the function you touch and fix it once in the shared code.
- If a failing check encodes the old behavior the task asks to change, do not guess the replacement from the task wording: implement through the canonical mechanism the environment already provides (an installed library, a platform standard) instead of hand-rolling a path or format. When that means importing a third-party library the project does not depend on yet, add it to the dependency manifest (setup.cfg / pyproject.toml / package.json) — a clean install must keep working.
- When the project is a public repository, look for the canonical fix in its history (`git log -S` in the checkout, a released version from the registry) instead of reconstructing it from memory. Port the whole change set, not just the hunk nearest the symptom: when the fix moves work between sites, update every site that consumed the old behavior. When the canonical change is broader than the symptom suggests (a global flag, a looser grammar), keep that breadth and adapt the neighboring code instead of narrowing the fix to look safe.
- Derive the check from the contract, not from the patch: every clause the report states becomes an assertion, including the edge case that separates fixed from unfixed (a read after expiry, an entry at a stale index). Assert through the door the report used — the function the report shows misbehaving sits inside the assertions itself, queried past the fixed-vs-unfixed boundary.
- Give that check its negative control in the same single run: it goes against the unfixed code first and fails there, then passes after the fix. One green run settles it — the negative control is not a second pass, and a baseline via `git stash` is not needed to get one. An observer that already agreed before the fix (`has`, `size`, a log line) cannot see the defect and proves nothing.
- If your script and the code disagree, the contract decides which one lies — never relax the check to go green.
- A throwaway test or fixture written only to verify this fix is deleted before you finish unless the task asked for tests: a clean diff carries only the fix, and scratch files left under the project's test tree break any patch applied on top of it.
