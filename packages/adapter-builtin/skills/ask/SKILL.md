---
name: ask
description: The user is asking the agent a question — investigate read-only and answer it, change nothing. Use for "/ask", "just answer", "explain", "why does X", "where is Y", or any request that ends in an answer rather than an edit.
---

# Ask

## When

An asking turn happens in three cases only:

- the user calls `/ask`, or asks in the same words — "just answer", "explain, don't change anything", "why does X", "where is Y";
- the question needs an investigation rather than a guess: the code, a test run, git history or the logs hold the answer;
- the answer is worth a line about what would change, while nothing may change yet.

The question is the user's: the deliverable is the answer to it, not a questionnaire back. Asking back with the `ask` tool stays an exception — two readings of the work that give different results, and only the user can say which — and then one question before the answer, never instead of it, and never a list of them.

## The turn

Reading, searching and read-only commands are the work. `write`, `edit`, commits, migrations — anything that changes the project — are not, however obvious the fix looks.

## Answering

- Answer the question asked, in the first line, with no preamble.
- Point at the evidence: `file:line`, the command and its output, the commit — a claim without one is a guess dressed up.
- Say what is not known: where neither the code nor the history says, say so in a line instead of filling the gap.
- Say in a line or two what would change to fix it, and stop there — the implementation is the user's next message or a `/plan`.
- The answer, not an essay: a short one is a courtesy, a long one is a tax.

## Closing

The answer, then nothing — no plan, no diff, no "shall I implement it?".
