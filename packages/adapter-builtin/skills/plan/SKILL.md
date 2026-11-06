---
name: plan
description: Plan a task before touching code — the turn ends with a plan the reader approves, not with a half-done implementation. Use for "/plan", "plan it first", "plan only", "no code yet", "break it into steps", or any request to design an approach before anything is changed.
---

# Plan

The deliverable of the turn is the plan. Reading, searching and running read-only commands are the work; edits, writes outside the plan file, and anything that changes the project are not — nothing has been approved yet.

## The plan itself

Publish it with the `plan` tool so the side panel shows it: `name` — the task in one line, as the reader says it; `overview` — what changes and why that way; `entries` — the steps in order; `plan` — the files, the reasoning, how each step is checked. `apply_plan` is the last call of the turn, and it is what asks for approval.

- A step is a change, not an activity: "return an empty result from `parseRange` and update its two callers", never "look at the code".
- The smallest set that solves the task. No refactor, no cleanup, no "while we're here".
- Every step names its check — a test, a command, the thing the reader will look at. A step without one is a wish; split it or drop it.
- The step touching the most callers goes first, while the plan is still cheap to change; name what it can break.
- An unknown becomes its own step (read X, measure Y) instead of a guess written as a fact.
- The reasoning section says which alternatives were dropped and why one line each — that is what the reader is actually approving.

## Closing

Call `apply_plan` and stop there: the panel asks the reader to approve the plan or edit it, and the turn ends with that answer. Do not implement "just the first step" while waiting, and do not start because the plan looks obvious.

`/plan <task>` is the whole request: no questions before the plan. Where a wrong guess would silently change the goal, write the assumption into the plan instead of asking; ask only when the goal itself is undecided.

Approved, the plan is the contract: the steps are the order of the work, and `plan` is called again as each one starts and lands. A step the reader changes on the way is changed in the plan file first.

If the plan tool is not offered in this chat, a plan as Markdown in the answer is the fallback — same steps, same checks, no `.acpio/plan.md`.
