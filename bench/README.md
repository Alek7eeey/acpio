# Agent benchmark

Compares the harnesses Acpio can drive — **vanilla pi**, **omp**, and Acpio's
**builtin** agent — on the same tasks, with the same model and the same
verification, so gaps in the builtin agent show up as numbers instead of
opinions.

## Run

```bash
node bench/run.mjs                                  # all agents × all tasks
node bench/run.mjs --agents builtin --repeats 3     # one agent, averaged
node bench/run.mjs --agents pi,omp --tasks fix-sum  # a subset
node bench/run.mjs --keep                           # leave workspaces on disk
node bench/run.mjs --model openai/gpt-4o-mini       # another provider
```

Each run gets a fresh workspace copied from the task's `fixture/`, a wall-clock
budget, and — after the agent stops — a hidden `verify.mjs` the agent never saw.
`PASS` means the verifier exited 0. Results are written to
`bench/results/<stamp>.jsonl` (machine rows) and `<stamp>.md` (table).

## Layout

```
bench/
  run.mjs                 orchestrator + report
  lib/util.mjs            process/workspace/verify helpers
  lib/jsonl.mjs           pi/omp `--mode json` event parsing → metrics
  lib/cli-agent.mjs       spawn drivers for pi and omp
  lib/builtin-agent.mjs   boots the real acpio server and drives the builtin agent
  tasks/<id>/
    task.json             prompt, timeout
    fixture/              files the agent starts with
    verify.mjs            hidden, copied in only for grading
```

## How each agent is driven

| agent | transport | permissions | isolation |
|---|---|---|---|
| `pi` | `node <pi>/dist/bundle/cli.js -p --mode json` | non-interactive, auto-approved | `--no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --offline` |
| `omp` | `omp --mode=json -p` | `--auto-approve` | `--no-extensions --no-skills --no-rules` |
| `builtin` | real `acpio` server, `POST /api/sessions/:id/prompt` | `permissionPolicy=always` | per-run temp SQLite DB, own port |

`omp` reads custom providers from `~/.omp/profiles/omp-bench/agent/models.yml`;
the runner writes that one file (never the default profile).

## Metrics

`wallMs`, tool call count + per-tool breakdown, tool errors, exit code,
`tokensIn/Out/Total` (summed over model calls), context footprint, cost,
final answer text, and pass/fail from the verifier.

### Caveats

- **Token accounting needs the endpoint to cooperate.** `builtin` asks for
  `stream_options.include_usage` (`includeUsage: true` in
  `packages/adapter-builtin/src/agent.ts`); servers that ignore it report
  `tokensIn/Out` as empty — read those as `n/a`, not `0`.
- **Model parity is the runner's job.** All three are pointed at the same
  `--model`; if a harness silently falls back to another model the run is still
  graded, so watch the first lines of the CLI output when comparing.
- **One task set is not a capability score.** These tasks are smoke-sized; they
  separate plumbing (edit precision, tool count, context handling) from
  end-to-end agent work only once more tasks exist.

## Adding a task

1. `bench/tasks/<id>/task.json` — `{ "id", "title", "prompt", "timeoutMs" }`.
2. `fixture/` — the starting workspace (omit for a from-scratch task).
3. `verify.mjs` — re-checks the requirement from scratch; never import the
   fixture's own tests, or a modified test passes the run.
