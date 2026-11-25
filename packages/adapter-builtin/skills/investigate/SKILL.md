---
name: investigate
description: Work out how a behaviour actually happens — trace the path through the code, prove every hop with a file, a command or a commit, and report the mechanism. Use for "how does X work", "where does this come from", "why is this happening" when the answer has to be traceable; read-only, nothing is edited.
read-only: true
---

# Investigate

## When

- the reader names a behaviour and asks how it happens, where it comes from, or why —
  and a guess would be the expensive mistake, because a change is about to be made in
  code nobody here has read yet;
- the answer has to hold up: a mechanism the reader can follow hop by hop, not a
  summary that happens to sound right;
- not the fix. A proven cause then goes to `verify-bugfix` (it makes the change and its
  failing check) or to `plan` when the change is bigger than one hunk. This turn ends
  with the mechanism understood.

## The turn

Reading, searching, read-only commands are the work: `grep`, `glob`, `read`, a test or
a script run for its output, `git log -S`. The harness refuses the tools that write
(`write`, `edit`, `plan`, `apply_plan`, `task`) for a read-only skill, so whatever the
trace concludes, it concludes in the chat.

## The trace

- Enter where the reader's symptom enters — the route, the button, the CLI flag, the
  job — and follow the value from there. Each hop is one line: `file:line`, and what
  that code does to it.
- Prove every hop with something the reader can open themselves: the `file:line`, the
  command and its output, the commit from `git log -S`. A hop held up by reading the
  name of a function is a guess dressed as a trace.
- Stop at the line that decides the behaviour — the one whose change would change what
  the reader sees. What runs after it is detail, and detail past that line is noise.
- Say which state got it there: the value written a screen earlier, the caller that
  passed nothing, the cache keyed on the wrong thing, the branch that falls through.

## The report

- The mechanism in one or two lines first: "X happens because A writes B and C reads it
  as D". The reader stops reading here when that is enough.
- Then the trace, hop by hop, each with its evidence — the evidence is the deliverable,
  not a garnish on it.
- Then what was ruled out (one line each, with the command that ruled it out) and what
  stayed unknown. A gap named as a gap is worth more than a plausible filling.
- Close with one line naming the code a change would have to touch, and stop there: no
  diff, no patch, no "shall I implement it?".
