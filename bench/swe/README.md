# SWE-bench Verified (`bench/swe/`)

The real benchmark — 500 human-validated GitHub issues across 12 Python
repositories — run against the acpio builtin agent and, in the same containers,
the `pi` and `omp` CLIs, in **our runner**: the official per-instance Docker
images and the official test lists do the verification, everything else
(driving the agents, the proxy, the metrics, the report) is the same machinery
as `bench/run.mjs`. No swebench harness orchestration and no scaffolding: from
the swebench world we take the image, the eval script and the FAIL_TO_PASS /
PASS_TO_PASS grading, nothing else (the principle from `BENCHMARKS.md` §4 —
"наш runner, их задачи").

## One-time setup

```bash
node bench/swe/fetch-dataset.mjs        # HF dataset -> bench/swe/data/swe-bench-verified.jsonl (500)
node bench/swe/prepare-agent-bundle.mjs # builds workspaces, then npm-installs prod deps
                                        # INSIDE a node:22 container (native modules must
                                        # be linux/glibc) -> bench/.cache/swe-agent-bundle.tar.gz
python3 -m pip install swebench         # 5.x; used only for eval-script normalization,
                                        # log parsing and list grading (swebench_cli.py)
```

The bundle also carries the CLI agents so all harnesses run inside the same
kind of container: pi (under the bundled node) and omp (under a bundled bun),
pinned to the exact versions installed on this machine. It is ~450 MB and
docker-cp'd into every rollout container.

The dataset is the SWE-bench org's current copy of Verified (not the original
`princeton-nlp` upload): it ships the per-instance eval script and the `_1776_`
image names that are live on Docker Hub today.

Requires Docker Desktop (Linux containers), ~1–3 GB disk per pulled instance
image, and an LLM endpoint reachable from containers (`127.0.0.1` URLs are
rewritten to `host.docker.internal` automatically).

## Run

```bash
node bench/swe/run-swe.mjs --instances pallets__flask-5014          # builtin only
node bench/swe/run-swe.mjs --agents builtin,pi,omp --instances pallets__flask-5014
node bench/swe/run-swe.mjs --instances psf__requests --limit 3      # repo substring
node bench/swe/run-swe.mjs --gold --instances pallets__flask-5014   # harness self-test
node bench/swe/run-swe.mjs --no-eval --instances sympy --limit 1    # rollout only
```

**Default model/provider:** `zen/space-bunny-free` on `https://opencode.ai/zen/go/v1`
(the free opencode zen endpoint; decision of 2026-09-30) — config lives in the
gitignored `bench/.cache/swe-provider.json`, so runs cost no tokens by default.
Override with `--model <provider>/<id>`, `--builtin-url`, `--builtin-key`, or
the `BENCH_BASE_URL` / `BENCH_API_KEY` env vars. The zen gateway requires the
`x-opencode-session` header — the proxy injects it per rollout automatically.

`--instances` matches substrings of `instance_id` (empty = all 500 — a
multi-day, multi-dollar run; think twice). `--agents` picks the harnesses —
each gets its **own container per instance** so every agent starts from the
untouched base commit. Useful flags: `--timeout` (rollout budget, default
45 min), `--eval-timeout` (official eval script, default 40 min),
`--concurrency N`, `--keep-images` (skip re-pulls on repeat runs), `--keep`
(keep containers for debugging), `--model`, `--proxy-dump`, `--prompt-file`
(template with `{problem}`).

**Start with `--gold`**: it applies the dataset's reference patch instead of
running the agent and must come back `RESOLVED`. It validates images, eval and
grading without spending a single model token.

### The frozen pilot set (stage-1 gate)

Six instances across the four fast repos, all FAIL_TO_PASS=1 with the smallest
PASS_TO_PASS sets so eval stays minutes, not tens of minutes:

```
pallets__flask-5014  psf__requests-1142  pylint-dev__pylint-4661
pylint-dev__pylint-6386  pytest-dev__pytest-5809  pytest-dev__pytest-7571
```

```bash
node bench/swe/run-swe.mjs --agents builtin,pi,omp \
  --instances pallets__flask-5014,psf__requests-1142,pylint-dev__pylint-4661,pylint-dev__pylint-6386,pytest-dev__pytest-5809,pytest-dev__pytest-7571 \
  --concurrency 2 --keep-images
```

Iterations of the builtin agent re-run exactly this set and compare against
`node bench/swe/baseline.mjs` — the best RESOLVED run per agent/instance across
all recorded runs, tokens from the wire. django/sympy stay out of iterations.

## Iteration log (one change per run, compared against the baseline)

- **2026-09-30, iter 1** — change: a system-prompt rule in
  `packages/adapter-builtin/src/agent.ts`: when a failing check encodes the old
  behavior the task asks to change, implement through the canonical mechanism
  the environment already provides (installed library, platform standard)
  instead of guessing from the task wording. Motivation: builtin's only pilot
  miss (pylint-4661) hardcoded `~/.local/share/pylint` while the canonical
  `appdirs.user_cache_dir` sat unused in the env — the agent had even seen the
  failing test and reasoned about it, but guessed the path from the issue text.
  Result: **6/6** (was 5/6), pylint-4661 RESOLVED via `appdirs`; wire: 181
  calls, 116k uncached for the full set. Stamp `2026-09-30T19-26-22-720Z`.
- **2026-09-30, iter 2** — corpus expanded 6 → 15 (fast repos only) and three
  harness-side fixes: auto-continue nudges for builtin's 50-step turn cap,
  mode-only diff blocks stripped from extracted patches (some sweb images ship
  the worktree 777), `serverStatus` recorded per row. Result: **14/15**
  (uncached 441k, 599 calls) — pylint-4661 failed again: the agent imported
  `platformdirs` and never updated the dependency manifest, so the eval's
  `pip install -e .` left `appdirs` uninstalled and the test module died at
  collection. Iteration 1 had passed only because it did edit setup.cfg.
- **2026-10-01, iter 3** — per the owner's call: the turn cap `MAX_TOOL_STEPS`
  50 → 10 000 (a turn ends when the model stops calling tools; the ceiling only
  catches a runaway loop), and the auto-continue nudges were **removed** as
  unfair — a stopped session is a stopped session. Agent change: the canonical-
  mechanism prompt rule now also requires adding a newly imported third-party
  library to the dependency manifest (setup.cfg / pyproject.toml /
  package.json). Result: **15/15** on the full set (uncached 305k, 452 calls,
  37m50s total). pylint-4661 patched `appdirs` into setup.cfg again. Stamp
  `2026-09-30T21-53-58-278Z`.

## What happens per instance

1. `docker run` the official `swebench/sweb.eval.x86_64.<instance>` image —
   the repo at the pre-fix commit, prepared conda env `testbed` at /testbed.
   One container per (instance, agent).
2. The Linux bundle is copied in and untarred to `/bundle`. builtin: the
   compiled acpio server starts inside the container with `PATH` pointing at
   the `testbed` conda env, so the agent's bash sees the project's real
   `python`. pi/omp: exec'd from the bundle (`node …/pi/dist/bundle/cli.js`,
   `bun …/omp/dist/cli.js`) with the same isolation flags as `bench/run.mjs`
   and their provider configs docker-cp'd in.
3. The agent gets the issue text (same minimal prompt for all agents) and works
   in `/testbed` — this is the part under test.
4. `git add -A && git diff <base_commit>` is extracted as the model patch
   (`bench/.work/swe-<stamp>/patches/<agent>-<instance>.patch`).
5. The dataset's official eval script resets the test files, applies the test
   patch, runs the suite; the log is parsed and graded by the swebench package
   against FAIL_TO_PASS / PASS_TO_PASS. RESOLVED requires every FAIL_TO_PASS
   green and zero PASS_TO_PASS regressions.

Containers are removed after each rollout; images are removed too unless
`--keep-images`.

## Outputs

- `bench/results/swe-<stamp>.jsonl` / `.md` — per-instance rows and the summary
  table (resolution, wall/rollout/eval time per task, wire tokens incl. cached
  and uncached, patch size) plus a **Timing** section: per-agent rollout
  avg/median/max, wall totals and the total run time.
- `bench/results/swe-runs.jsonl` — one line per run (the run index future
  analysis reads first): stamp, model, agents, resolved/failed/errored counts,
  total run wall time, rollout/eval sums, wire token sums per agent.
- `bench/results/swe-all-runs.jsonl` — append-only per-instance ledger across
  runs (timing, tokens, tool calls, errors), the SWE counterpart of
  `all-runs.jsonl`. Every run appends, errored runs included.
- `bench/.work/swe-<stamp>/` — per instance-agent: `patches/`, raw test
  `logs/`, grading `reports/`, agent action history in `transcripts/`.
- `bench/results/swe-<stamp>.calls.jsonl` — the proxy wire capture, one line
  per model call with the agent label and server-reported usage; token truth
  for post-hoc analysis (`analyze.mjs` works on the same format).

## Caveats

- **Suite weight is real**: django/sympy instances run test suites that take
  tens of minutes and images of 2–3 GB. Iterate on the small repos (flask,
  requests, astroid, pytest); sweep django only in bulk runs.
- **The bundle is a build of this repo**: after changing the agent, re-run
  `prepare-agent-bundle.mjs` or you benchmark last build. The stamp file
  `bench/.cache/swe-agent-bundle.json` records the git sha and the pinned
  pi/omp versions it was built from.
- **Harness comparison is like-for-like**: pi and omp run in the same official
  containers with the same model, the same prompt and the same proxy as
  builtin. What differs between runs is only the harness under test. omp's
  numbers come through the shared `summarizeAgentStream` parser, builtin's
  through its session API; token accounting differs slightly between the two
  sources — trust the proxy's `.calls.jsonl` for wire-level comparisons.
- A rollout that hits `--timeout` is cancelled/killed and graded on whatever
  the working tree holds at that point.
