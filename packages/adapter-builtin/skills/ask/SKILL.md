---
name: ask
description: Ask before touching code — the turn ends with the questions answered, not with an edit. Use for "/ask", "ask me first", "questions only", "clarify first", "don't change anything yet", or a task whose result hinges on a decision only the user can make.
---

# Ask

## When

An asking turn happens in three cases only:

- the user asks for questions instead of work — "ask me first", "/ask", "questions only", "don't touch the code", "clarify first";
- the work cannot be done without one of the user's decisions: two readings of the task that give different results, a behaviour only they can pick, a scope or a value no file states;
- you catch yourself about to guess something the user would have to undo later.

Not for what the repository already answers: `read`/`grep`/`glob`, git history and a test run are cheaper than a question, so find it yourself and ask only what the files cannot say.

## The turn

The deliverable of the turn is the questions and their answers, nothing else. Reading, searching and read-only commands are the work; `write`, `edit`, commits, migrations — anything that changes the project — are not, however obvious the fix looks.

## Asking

Ask with the `ask` tool, all questions in one call, and only the ones that branch the work: a question the reader answers without thinking is noise, and a question whose answer would not change what you do is worse.

- Each question carries 2–4 concrete options — the choice, not a topic — with the one you would pick first saying so in a line. `allow_free_text` stays on unless the answer must be exact.
- Before the call, say in one line what each question decides; after it, nothing has to be re-asked.
- The reader may decline or leave it blank: do not ask again — state the assumption you will take and stop.

## Closing

After the answers, one short block: the decision taken per question, one line each, and the step or file it changes. Then stop — no code, no plan unless the user asked for one; the implementation is their next message or a `/plan`.

If the answers leave the work undecided, say in a line what is still open and ask the next question — still without editing.
