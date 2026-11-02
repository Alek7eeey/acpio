---
name: goal-loop
description: Carry a task to a checkable goal without stopping between steps — the goal and its check are fixed once, then each iteration ends in a run of that check, and the turn only ends when it passes, on a real blocker, or when the user stops. Use when the user says "автономно", "until it's done", "продолжай", "доведи до результата", "не спрашивай", or when the goal is measurable (a metric, a passing command) and reaching it takes many steps.
---

# Goal loop

The stopping point is the goal, not the end of a step. Plan, narration and asking are work that costs the user a turn — spend them once, at the start.

## Before the first step

Write the goal as a check you can run: the command and the threshold (`npm run eval → ΔV ≤ 0.5%`, `npm test → green`, `IoU ≥ 0.99`). Without it there is no goal, only activity — fix the check first.

Ask the user only if the goal needs something only they can give: which variant is meant, a threshold the request names nowhere, a file or credential. One message, all such questions at once, then never again. Everything else — an unknown cause, a choice between two approaches, a number to tune — is yours to decide and record.

## An iteration

One change, its check, one line: `#4 1452 → 380 mm³ — полосы по петлям вместо площади`. Then the next iteration, immediately. Do not end a turn with what you are about to do, what you would check next, or a question inviting approval nobody asked for.

The turn ends for exactly three reasons:

- the check passes — say the number and stop;
- a blocker only the user can clear — name what is missing in one line and stop;
- the user stopped you.

Nothing in the harness needs a pause between steps: the user's Stop button bounds the run, so "saving the user a step" by stopping early is the opposite of what was asked.

## When an iteration fails

- Same cause twice → a different hypothesis, not a retry of the same run.
- Two iterations with no movement in the metric → write the three candidate causes down, test the cheapest, keep going. Asking is not one of the moves.
- The same approach failing a third time is a blocker: say which three you eliminated and what you need.
- Never move the threshold, weaken the check or call a partial result a success to finish. A goal you cannot reach, with the numbers that show why, is a truthful end — a lowered bar is not.

## While other skills are on

Ponytail's discipline still decides how much code the change needs; this skill decides when you stop. Its closing line ("what you skipped") is a plan for the next run — under this skill the closing line is the iteration's journal line instead.
