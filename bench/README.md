# Agent benchmark

Compares the harnesses Acpio can drive — **vanilla pi**, **omp**, and Acpio's
**builtin** agent — on the same tasks, with the same model and the same
verification, so gaps in the builtin agent show up as numbers instead of
opinions. Task families, iteration methodology and the official-benchmarks
landscape (SWE-bench, Terminal-Bench, polyglot, …) live in
[`ITERATIONS.md`](ITERATIONS.md) and [`BENCHMARKS.md`](BENCHMARKS.md).

## Goals

Why the bench exists, in the order that decides arguments:

1. **Develop the builtin agent on numbers, not impressions.** Every agent
   change is one iteration, measured against the frozen baseline
   (`bench/swe/baseline.mjs`, `bench/results/`); tokens come from the wire
   (`*.calls.jsonl`), verification is hidden, self-reports don't count.
2. **Beat pi/omp on all three axes — pass rate, wall time, and cost per
   solved task.** Same corpus, same containers, same model and endpoint, so
   the delta is pure agent engineering; `baseline.mjs` compares against every
   agent's BEST recorded run, not its average. Accuracy is the primary metric;
   time and tokens are its price — efficiency is uncached tokens per RESOLVED
   task, never raw totals (a hung rollout burns wall time but no tokens).
3. **Keep every corpus discriminative.** Pass rate means nothing once agents
   saturate it; expansions (20 → 40 → 60 synthetic, 26 → 100 Verified
   instances) are driven by saturation, and failed-instance gold self-tests
   keep the corpus honest before an agent miss is believed.
4. **External validity: our runner, their tasks.** Official corpora serve as
   the source of tasks and hidden verification (official docker images,
   official eval scripts, FAIL_TO_PASS/PASS_TO_PASS grading); synthetic tasks
   are the fast internal discriminator and are never presented as SWE-bench
   results.
5. **Two measurement loops.** The fast synthetic family (minutes per task,
   no network) drives daily iterations; the official anchor (SWE-bench
   Verified) confirms the inner loop maps to real-world work. Terminal-Bench
   is the planned third leg for the terminal-task class.

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
node bench/run.mjs --family long                    # the long-horizon family (20 min/task)
node bench/run.mjs --tasks fix-sum --faults junk-context  # A/B: same task, obstructed
node bench/run.mjs --tasks-root bench/private/tasks --tasks priv-copy-overwrite
node bench/horizon.mjs                              # pass rate by human-time bucket
node bench/selftest.mjs                             # bug fails, golds pass, faults don't mask
node bench/run.mjs --keep                           # leave workspaces on disk
node bench/run.mjs --model openai/gpt-4o-mini       # another provider
node bench/run.mjs --proxy-verbose                  # log every model call
node bench/run.mjs --proxy-dump                     # keep full request bodies
node bench/run.mjs --no-proxy                       # direct calls, no capture
```

The default sweep is the fast contour: tasks whose `horizon` is `xs`/`s`
(`long` tasks opt in via `--family long` or an explicit `--tasks` list).
Each run gets a fresh workspace copied from the task's `fixture/`, a
wall-clock budget, and — after the agent stops — a hidden `verify.mjs` the
agent never saw. `PASS` means the verifier exited 0. Results are written to
`bench/results/<stamp>.jsonl` (machine rows), `<stamp>.md` (table), and
`<stamp>.calls.jsonl` (one line per model call, from the proxy).

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
   "difficulty", "horizon", "family" }`. `difficulty` is the generated swe
   family's grade (easy/medium/hard); `horizon` is the estimated HUMAN time
   bucket (`xs` <15 min, `s` 15–60 min, `m` 1–4 h, `l` >4 h — the
   METR-style ladder `bench/horizon.mjs` reports by); `family` groups the
   task (`long` multi-phase, `ambiguity` underspecified asks, `private`
   internal incidents; unset = the base synthetic corpus).
2. `fixture/` — the starting workspace (omit for a from-scratch task).
3. `verify.mjs` — re-checks the requirement from scratch; never import the
   fixture's own tests, or a modified test passes the run.
4. Optional `solution/` (and `solution-alt/` for tasks with several
   defensible readings) — a full snapshot of the solved fixture. Required
   input for `bench/selftest.mjs`.
5. Optional `faults.mjs` — named, strictly additive workspace mutations
   (misleading notes, planted noise) applied only on `--faults <name>`. A
   fault must never touch the graded path, so clean and faulted runs stay
   comparable A/B.
6. `node bench/selftest.mjs --only <id>` must be green: pristine fixture
   fails, every solution passes, faults obstruct without masking.

## Everyday-capability layer

The SWE-shaped corpora measure "fix someone else's bug from a good issue".
The shapes below cover what everyday use actually stresses; each is opt-in
and additive — the default sweep stays the fast xs/s contour.

- **Time-horizon ladder** — `node bench/horizon.mjs [--model m]`: pass rate
  by human-time bucket across the host and SWE ledgers (Verified instances
  carry the dataset's own difficulty annotation). This is the headline
  "everyday capability" number: a flat pass rate over uniformly short tasks
  says nothing about multi-hour work.
- **`long` family** (`--tasks long-*` or `--family long`, 20-minute agent
  budget): green a red suite across four root causes, build a pipeline from
  SPEC.md over dirty CSVs, migrate an app between routers behavior-preserving,
  split a monolith by contract. Behavioral hidden verifiers, no diff oracles —
  and the only tasks long enough to exercise compaction mid-run.
- **`ambiguity` family**: one-paragraph asks that leave real choices open.
  The hidden verifier accepts any defensible interpretation (multi-oracle)
  and requires an ASSUMPTIONS.md; a `rubric.md` per task grades the handling
  for a future LLM judge.
- **Fault injection** — `--faults <name>` (repeatable list): applies the
  task's `faults.mjs` mutation before the agent starts. Compare faulted vs
  clean pass rates and uncached tokens for the same task; `faults` is
  recorded in the result row and the ledger.
- **`private` eval** — `bench/private/` (Russian README): tasks distilled
  from this repo's own incidents, run only via
  `--tasks-root bench/private/tasks`. `bench/private/extract.mjs <commit>
  <task-id>` scaffolds a task from a real fix.

## Layout

```
bench/
  run.mjs                 orchestrator + report (host fast loop, dev only)
  run-docker.mjs          same tasks in the SWE-style docker sandbox (default)
  horizon.mjs             pass rate by human-time bucket (the ladder)
  selftest.mjs            corpus honesty: bug fails, gold passes, faults don't mask
  lib/util.mjs            process/workspace/verify helpers
  lib/jsonl.mjs           pi/omp `--mode json` event parsing → metrics
  lib/cli-agent.mjs       spawn drivers for pi and omp
  lib/builtin-agent.mjs   boots the real acpio server and drives the builtin agent
  lib/faults.mjs          --faults applier (strictly additive mutations)
  lib/proxy.mjs           capturing OpenAI-compatible proxy (the wire, not self-reports)
  private/                internal-incident tasks + scaffolder (see private/README.md)
  swe/                    SWE-bench Verified (the real corpus) — see swe/README.md
  swe-tasks/              swe task definitions (easy/medium/hard) for gen-swe-tasks.mjs
  tasks/<id>/
    task.json             prompt, timeout, difficulty, horizon, family
    fixture/              files the agent starts with
    verify.mjs            hidden, copied in only for grading
    solution/             gold snapshot(s) for selftest (never shipped to the agent)
    faults.mjs            optional named mutations for --faults
```
