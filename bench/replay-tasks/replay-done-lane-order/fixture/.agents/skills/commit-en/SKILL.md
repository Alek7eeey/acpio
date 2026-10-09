---
name: commit-en
description: Create a git commit
disable-model-invocation: true
---

Build a commit message from the current changes and create the commit.

# Commits in English

When creating commits (at the user's request), write the messages **in English**.

## How to phrase

- Concise, imperative mood: "Fix…", "Add…", "Remove…".
- Focus on **why**, not a list of changed files.
- 1–2 sentences; the first line is the essence of the change.
- **No prefixes:** do not use `feat:`, `fix:`, `docs:`, or similar.

## Splitting commits

- **Split when the changes are logically independent.** A refactor plus a bugfix in one commit is bad.
- **Don't overdo it.** Implementation + tests + docs = one commit.
- **The "and" rule:** if you need "and" for unrelated ideas, split. If it ties together parts of one task, don't.
- A commit must be self-contained — explainable in one sentence.

## When to use another language

- Proper names, APIs, CLIs, types, and identifiers in code (`SessionDetailDto`, `ChatSidebar`, `mcpDisabledIds`, `ModelPicker`).
- The message must match an external standard (e.g. conventional commits in CI, or an upstream PR template).
- The user explicitly asks for another language.

## Examples

```
Fix duplicate model refs in ModelPicker by keying them per node instead of per modelValue.

Send MCP servers to the agent only on session/new, load, and resume.

Add an archive-all action to the folder context menu.

Move the folder drag handle to the start of the row on touch devices.
```

Keep technical terms as-is when translating reads worse: `MCP`, `ACP`, `webhook`, endpoint and DTO names.
