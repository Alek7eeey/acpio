---
name: plan
description: Plan a task before touching code — the turn ends with a plan the reader approves, not with a half-done implementation. Use for "/plan", "plan it first", "plan only", "no code yet", "break it into steps", any request to design an approach before anything is changed, or a change you judge too large to start without one.
---

# Plan

## When

A plan is made in three cases only:

- the user asks for one — «составь план», "plan it first", "сначала план";
- the skill is invoked — `/plan <task>`;
- you find the change large: many files, or the steps are not clear yet — and you say so before starting.

With none of the three the work is done straight away and nothing goes to the panel: a plan nobody asked for is a plan the reader scrolls past.

## The turn

Once a trigger holds, the deliverable of the turn is the plan. Reading, searching and running read-only commands are the work; edits, writes outside the plan file, and anything that changes the project are not — nothing has been approved yet.

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

The answer that carries `apply_plan` says in one line that the plan is ready, and stops there. The card above the input carries the three answers: `Открыть план` opens the whole plan, «Одобрить» starts the work, «Отклонить» ends the turn with nothing implemented — the reader then says what to change, and only that brings the plan back to the file. One line: the steps themselves live in the panel, not in the answer.

`/plan <task>` is the whole request: no questions before the plan. Where a wrong guess would silently change the goal, write the assumption into the plan instead of asking; ask only when the goal itself is undecided.

Approved (from that card, or from «Утвердить и начать» in the panel — with the pace the reader picked there: all at once or one step at a time), the plan is the contract: the steps are the order of the work, and `plan` is called again as each one starts and lands. A step the reader changes on the way is changed in the plan file first.

If the plan tool is not offered in this chat, a plan as Markdown in the answer is the fallback — same steps, same checks, no `.acpio/plan.md`.
