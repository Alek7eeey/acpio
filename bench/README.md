# Agent benchmark

Compares the harnesses Acpio can drive — **vanilla pi**, **omp**, and Acpio's
**builtin** agent — on the same tasks, with the same model and the same
verification, so gaps in the builtin agent show up as numbers instead of
opinions. Task families, iteration methodology and the official-benchmarks
landscape (SWE-bench, Terminal-Bench, polyglot, …) live in
[`ITERATIONS.md`](ITERATIONS.md) and [`BENCHMARKS.md`](BENCHMARKS.md).

## Run

**By default benchmarks run in Docker** (decision 2026-10-01). `bench/run-docker.mjs`
executes the same tasks and agents inside the SWE-style sandbox: the
`acpio-daily-sandbox` image (node + the unpacked agent bundle, rebuilt by
`bench/swe/prepare-agent-bundle.mjs` into `bench/.cache/`), a pool container per
slot, a clean `/workspace` per pair, and the hidden verify exec'd inside the
container. The host loop `bench/run.mjs` is the fast dev contour for iterating
on the runner itself and for express checks — it is not the default.

```bash
node bench/run-docker.mjs                           # default: all agents × all tasks (docker)
node bench/run-docker.mjs --agents builtin --concurrency 8
node bench/run.mjs                                  # host fast loop (dev only)
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
  run.mjs                 orchestrator + report (host fast loop, dev only)
  run-docker.mjs          same tasks in the SWE-style docker sandbox (default)
  lib/util.mjs            process/workspace/verify helpers
  lib/jsonl.mjs           pi/omp `--mode json` event parsing → metrics
  lib/cli-agent.mjs       spawn drivers for pi and omp
  lib/builtin-agent.mjs   boots the real acpio server and drives the builtin agent
  lib/proxy.mjs           capturing OpenAI-compatible proxy (the wire, not self-reports)
  swe/                    SWE-bench Verified (the real corpus) — see swe/README.md
  swe-tasks/              swe task definitions (easy/medium/hard) for gen-swe-tasks.mjs
  tasks/<id>/
    task.json             prompt, timeout, difficulty (swe family)
    fixture/              files the agent starts with
    verify.mjs            hidden, copied in only for grading
```

## How each agent is driven

| agent | transport | permissions | isolation |
|---|---|---|---|
| `pi` | `node <pi>/dist/bundle/cli.js -p --mode json` | non-interactive, auto-approved | `--no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --offline` + own config dir |
| `omp` | `omp --mode=json -p` | `--auto-approve` | `--no-extensions --no-skills --no-rules` |
| `builtin` | real `acpio` server, `POST /api/sessions/:id/prompt` | `permissionPolicy=always` | per-run temp SQLite DB, own port |
| `builtin-clm` | the same server, sessions created with `provider: builtin-clm` | `permissionPolicy=always` | same as `builtin`; the CLM variant keeps its memory in a context file |

Custom providers are written per run, never inherited from daily-use config:
`omp` gets `~/.omp/profiles/omp-bench/agent/models.yml` (never the default
profile), `pi` gets `<run>/pi-agent/models.json` with `PI_CODING_AGENT_DIR`
pointing at it, `builtin` gets `PUT /api/settings`.

## Metrics

`wallMs`, tool call count + per-tool breakdown, tool errors, exit code,
`tokensIn/Out/Total` (summed over model calls), context footprint, cost,
final answer text, and pass/fail from the verifier.

In the summary tables the token columns are proxy numbers when the proxy ran —
`tok in`, `tok cached`, `tok uncached` are the same source for all three
harnesses; harness self-reports fill in only when the proxy has nothing for
that run (`--no-proxy`, a crash before the first call). `tok uncached` is the
honest cost metric: the input the provider actually had to read, which a big
stable system prompt flatters away in the cache-rate percentage.

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

## Iteration workflow

Improving the builtin agent is an iteration loop, not a one-off comparison:

1. **One change per iteration**, then `node bench/run.mjs --agents builtin --proxy-dump`.
2. Compare against the **frozen baseline** — `node bench/baseline.mjs` prints the
   best passing run per agent/task across every recorded stamp. pi and omp do
   not change between iterations: their reference is their best observed run,
   not whichever run happened last. Re-run them only when the model, endpoint or
   their versions change.
3. `node bench/analyze.mjs bench/results/<stamp>.calls --tool-calls` breaks each
   task's uncached tokens into per-call tails (assistant reasoning and tool
   args vs tool results) — that is where the next change comes from.
4. `node bench/grid.mjs <stamp> [--floor-prev <prev-stamp>]` prints the run's
   summary grid (pass, model calls, tools/errors, wire tokens, wall time,
   first-call floor) with the frozen best-of and the previous run alongside —
   paste it as is at the end of the iteration's journal entry.

Every run appends one line per run row to `bench/results/all-runs.jsonl`
(timestamp, git sha, model, agent, task, pass, wall, tools, tool errors, wire
token counts) — the append-only statistic future analysis reads first.
`toolErrors` is the first thing to look at: a failed tool call is a wasted step.

## Adding a task

1. `bench/tasks/<id>/task.json` — `{ "id", "title", "prompt", "timeoutMs",
   "difficulty" }` (the last one for the generated swe family: easy/medium/hard).
2. `fixture/` — the starting workspace (omit for a from-scratch task).
3. `verify.mjs` — re-checks the requirement from scratch; never import the
   fixture's own tests, or a modified test passes the run.
