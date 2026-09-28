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
node bench/run.mjs --proxy-verbose                  # log every model call
node bench/run.mjs --proxy-dump                     # keep full request bodies
node bench/run.mjs --no-proxy                       # direct calls, no capture
```

Each run gets a fresh workspace copied from the task's `fixture/`, a wall-clock
budget, and — after the agent stops — a hidden `verify.mjs` the agent never saw.
`PASS` means the verifier exited 0. Results are written to
`bench/results/<stamp>.jsonl` (machine rows), `<stamp>.md` (table), and
`<stamp>.calls.jsonl` (one line per model call, from the proxy).

## Layout

```
bench/
  run.mjs                 orchestrator + report
  lib/util.mjs            process/workspace/verify helpers
  lib/jsonl.mjs           pi/omp `--mode json` event parsing → metrics
  lib/cli-agent.mjs       spawn drivers for pi and omp
  lib/builtin-agent.mjs   boots the real acpio server and drives the builtin agent
  lib/proxy.mjs           capturing OpenAI-compatible proxy (the wire, not self-reports)
  tasks/<id>/
    task.json             prompt, timeout
    fixture/              files the agent starts with
    verify.mjs            hidden, copied in only for grading
```

## How each agent is driven

| agent | transport | permissions | isolation |
|---|---|---|---|
| `pi` | `node <pi>/dist/bundle/cli.js -p --mode json` | non-interactive, auto-approved | `--no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --offline` + own config dir |
| `omp` | `omp --mode=json -p` | `--auto-approve` | `--no-extensions --no-skills --no-rules` |
| `builtin` | real `acpio` server, `POST /api/sessions/:id/prompt` | `permissionPolicy=always` | per-run temp SQLite DB, own port |

Custom providers are written per run, never inherited from daily-use config:
`omp` gets `~/.omp/profiles/omp-bench/agent/models.yml` (never the default
profile), `pi` gets `<run>/pi-agent/models.json` with `PI_CODING_AGENT_DIR`
pointing at it, `builtin` gets `PUT /api/settings`.

## Metrics

`wallMs`, tool call count + per-tool breakdown, tool errors, exit code,
`tokensIn/Out/Total` (summed over model calls), context footprint, cost,
final answer text, and pass/fail from the verifier.

## Wire diagnostics (the proxy)

By default every agent is pointed at a local proxy in front of the provider, so
the comparison does not depend on what each harness says about itself. Per model
call `bench/results/<stamp>.calls.jsonl` records: message count, characters per
role, system-prompt head, tool count + schema size + tool names, sampling
parameters (`stream`, `stream_options.include_usage`, `max_completion_tokens`,
`tool_choice`, `temperature`, …), HTTP status, latency, finish reason, the tool
calls the *model* asked for, and the server-reported `usage`.

`--proxy-dump` writes full request bodies to `<stamp>.calls/NNN-<agent>-<model>.json`
— the only way to read an agent's real system prompt and tool schemas.
`--proxy-verbose` prints a line per call while the run goes.

What it settled on the reference endpoint:

- **`usage` is available** — the provider returns prompt/completion tokens on
  every call when the client asks (`include_usage: true`, which all three do),
  plus `prompt_tokens_details.cached_tokens` (llama.cpp also reports the same
  number as `timings.cache_n`). Cached input is part of the input count, so it
  is tracked in its own column: it is the input the provider did *not* have to
  read, which is where the wall time and the money go on repeated prefixes.
- **All three stream** and none sets `temperature`/`top_p`: sampling is whatever
  the server defaults to. Only pi/omp bound output (`max_completion_tokens: 16384`);
  the builtin agent sends no output cap.
- **Prompt overhead differs by an order of magnitude**: system prompt 737 chars
  (builtin) vs 2717 (pi) vs 10083 (omp); tool schemas 4319/2841/14490 chars.
  That, not "intelligence", is most of the token gap on small tasks.
- **Model calls are not tool calls**: a run shows N model calls for N+1 tool
  rounds plus the final answer, which is why client-side `tools=` counts differ
  from `calls`.

### Caveats

- **Model parity is the runner's job.** All three are pointed at the same
  `--model`; a harness that silently falls back to another model is still
  graded, so check the first lines of the CLI output when comparing.
- **The proxy is one hop, same process family.** It drops `accept-encoding` (so
  bodies are readable) and adds a localhost hop; wall times stay comparable, but
  do not read them as network benchmarks.
- **One task set is not a capability score.** These tasks are smoke-sized; they
  separate plumbing (edit precision, tool count, context handling) from
  end-to-end agent work only once more tasks exist.

## Adding a task

1. `bench/tasks/<id>/task.json` — `{ "id", "title", "prompt", "timeoutMs" }`.
2. `fixture/` — the starting workspace (omit for a from-scratch task).
3. `verify.mjs` — re-checks the requirement from scratch; never import the
   fixture's own tests, or a modified test passes the run.
