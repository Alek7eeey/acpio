# AGENTS.md

Rules for agents working in this repository. They sit in the system prompt of every
chat opened here, so keep them short and keep them true.

## The request head is written once per chat

**Nothing may change the prompt bytes a session has already sent — the `system`
text, the tool declarations, or any message in the middle of the history. The only
exception is a pass that rewrites the context on purpose (compaction).**

Anything that becomes relevant mid-chat — a project rule whose `globs` start to
match, a reminder, a note about a file — is **appended behind everything already
sent**, never merged into the head and never inserted in the middle. Appending is
free: the provider answers the unchanged prefix from its cache and charges only the
new tail. Rewriting the head throws that cache away and bills the whole history
again.

This is a money rule, not a style preference. Measured: chat `b0c36ffa` sent 42
messages, 40 of them identical, and still paid for all 50 768 tokens, because five
`.cursor/rules/*.mdc` files inlined themselves into `messages[0]` when the agent
read a `**/*.ts` file. Before that request the same chat was running at 92% cache.

When you touch prompt assembly:

- Build the head once (system prompt, skills block, project rules, and the
  settings those are written from) and persist it with the session, like
  `frozenSkills`, `frozenRules` and `frozenHead` in
  `packages/adapter-builtin/src/agent.ts`. A transport rebuilt mid-chat must resume
  on the same bytes — the stored `promptHead` is what makes a restart or a saved
  settings page land on them instead of on whatever the settings say now.
- A setting that shapes the head — reply language, the plan tool, MCP tool
  allow-lists, project rules, skill modes — reaches a chat on its **first** turn
  and never mid-session; the reader sees it in the next chat. Live per-turn reads
  stay for what the reader's own turn decides (the model, thinking, limits) and
  for the tail.
- A situational block lands once. Record that it landed (see `deliveredRules`) so
  the next request repeats neither the text nor the cost.
- Any per-turn recomputation of something that goes into the head — a sorted MCP
  server list, an edited rule file, a touched-file check — is a cache miss waiting
  to happen. Ask: *can this differ between two requests of one session?* If yes, it
  may not sit in the head.

## Smallest change

Change what the task asks for, in the place the cause lives. No drive-by refactors,
no speculative options, no compatibility shims for code only this repository calls.
Comments explain *why* — a measured failure, a bill, a provider quirk — not what the
next line does.
