// SWE-bench Verified runner: the real benchmark against the builtin agent.
//
//   node bench/swe/run-swe.mjs --instances pallets__flask-5014
//   node bench/swe/run-swe.mjs --instances psf__requests --limit 2 --timeout 1800000
//   node bench/swe/run-swe.mjs --instances pallets__flask-5014 --gold   # harness self-test
//
// Per instance: pull the official `swebench/sweb.eval.x86_64.*` image (repo at
// the pre-fix commit, prepared conda env), start the compiled acpio server
// INSIDE the container (bench/.cache/swe-agent-bundle.tar.gz, built by
// prepare-agent-bundle.mjs), let the agent work in /testbed, extract
// `git diff` as the model patch, then run the dataset's official eval script
// and grade with the swebench package. `--gold` applies the dataset's reference
// patch instead of running the agent — every stage except the rollout.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentArgs, ensureOmpModel, ensurePiModel, ompProfile } from "../lib/cli-agent.mjs";
import { summarizeAgentStream } from "../lib/jsonl.mjs";
import { loadFromCache, saveToCache } from "./image-cache.mjs";
import { LlmProxy } from "../lib/proxy.mjs";
import { runProcess } from "../lib/util.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATASET = path.join(REPO, "bench", "swe", "data", "swe-bench-verified.jsonl");
const BUNDLE = path.join(REPO, "bench", ".cache", "swe-agent-bundle.tar.gz");
const SWEBENCH_CLI = path.join(REPO, "bench", "swe", "swebench_cli.py");
const RESULTS = path.join(REPO, "bench", "results");
const WORK = path.join(REPO, "bench", ".work");
const SERVER_PORT = 18741;

const PROMPT_TEMPLATE = `You are an expert software engineer. The repository checked out at /testbed (a real open-source project, at the commit just before the fix) has this issue:

{problem}

Find the root cause and fix it. Work only inside /testbed. \`python\` is the project's prepared environment (conda env \`testbed\`; if a shell lacks it: \`source /opt/miniconda3/bin/activate testbed\`). Verify the fix by running the relevant tests yourself and iterate until they pass. Do not modify existing tests, do not reformat unrelated code, and leave your changes uncommitted in the working tree when you are done.`;

function parseArgs(argv) {
  // The default provider lives in bench/.cache/swe-provider.json (gitignored):
  // opencode zen + the free model, per the 2026-09-30 decision — runs cost no
  // tokens by default. BENCH_BASE_URL / BENCH_API_KEY env and CLI flags override.
  let provider = { url: "http://api.ai.dev.imdomain/v1", key: "no", model: "im/im-llm" };
  try {
    const p = JSON.parse(readFileSync(path.join(REPO, "bench", ".cache", "swe-provider.json"), "utf8"));
    provider = { url: p.url, key: p.key, model: p.model };
  } catch {}
  const out = {
    agents: ["builtin"],
    instances: [],
    limit: 0,
    model: provider.model,
    builtinUrl: process.env.BENCH_BASE_URL || provider.url,
    builtinKey: process.env.BENCH_API_KEY || provider.key,
    contextWindow: Number(process.env.BENCH_CONTEXT_WINDOW || 64000),
    timeoutMs: 2_700_000,
    evalTimeoutMs: 2_400_000,
    concurrency: 1,
    promptFile: null,
    keep: false, // keep containers (debugging)
    keepImages: false, // keep pulled images (fast repeats, ~1-2 GB each)
    gold: false,
    noEval: false,
    proxy: true,
    proxyDump: false,
    proxyVerbose: false,
    sessionHeader: process.env.BENCH_SESSION_HEADER || "x-opencode-session",
    out: RESULTS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = inline ?? argv[i + 1];
    const take = () => {
      if (inline === undefined) i += 1;
      return value;
    };
    switch (flag) {
      case "--agents": out.agents = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--instances": out.instances = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--limit": out.limit = Number(take()); break;
      case "--model": out.model = take(); break;
      case "--builtin-url": out.builtinUrl = take(); break;
      case "--builtin-key": out.builtinKey = take(); break;
      case "--context-window": out.contextWindow = Number(take()); break;
      case "--timeout": out.timeoutMs = Number(take()); break;
      case "--eval-timeout": out.evalTimeoutMs = Number(take()); break;
      case "--concurrency": out.concurrency = Math.max(1, Number(take())); break;
      case "--prompt-file": out.promptFile = path.resolve(take()); break;
      case "--keep": out.keep = true; break;
      case "--keep-images": out.keepImages = true; break;
      case "--gold": out.gold = true; break;
      case "--no-eval": out.noEval = true; break;
      case "--proxy": out.proxy = true; break;
      case "--no-proxy": out.proxy = false; break;
      case "--proxy-dump": out.proxyDump = true; break;
      case "--proxy-verbose": out.proxyVerbose = true; break;
      case "--session-header": out.sessionHeader = take(); break;
      case "--out": out.out = path.resolve(take()); break;
      case "--help": out.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return out;
}

function usage() {
  console.log(
    [
      "SWE-bench Verified runner for the builtin agent (and, in the same containers, pi / omp).",
      "",
      "  node bench/swe/run-swe.mjs --instances pallets__flask-5014",
      "  node bench/swe/run-swe.mjs --agents builtin,pi,omp --instances pallets__flask-5014",
      "  node bench/swe/run-swe.mjs --instances sympy --limit 5 --concurrency 2",
      "  node bench/swe/run-swe.mjs --instances pallets__flask-5014 --gold",
      "",
      "--agents a,b      builtin | pi | omp; each gets a fresh container per instance",
      "--instances a,b   instance_id substrings; empty = all 500 (think twice)",
      "--timeout ms      rollout budget per instance (default 45 min)",
      "--eval-timeout ms budget for the official eval script (default 40 min)",
      "--gold            apply the reference patch instead of running the agent",
      "--no-eval         rollout only, no test run",
      "--keep / --keep-images  keep containers / pulled images after the run",
      "",
      "Requires bench/.cache/swe-agent-bundle.tar.gz (unless --gold):",
      "  node bench/swe/prepare-agent-bundle.mjs",
    ].join("\n"),
  );
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function freePort() {
  for (let p = 4500 + Math.floor(Math.random() * 2000); ; p++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
}

async function docker(args, { timeoutMs = 120_000 } = {}) {
  const res = await runProcess("docker", args, { timeoutMs });
  return res;
}

async function dockerOk(args, opts) {
  const res = await docker(args, opts);
  if (res.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${res.code}): ${(res.stderr || res.stdout || "").slice(-500)}`);
  }
  return res;
}

async function dockerExec(container, cmd, timeoutMs) {
  return docker(["exec", container, "/bin/bash", "-c", cmd], { timeoutMs });
}

/** One tiny python call into the swebench glue. */
async function pythonCli(args, timeoutMs = 120_000) {
  const res = await runProcess("python3", [SWEBENCH_CLI, ...args], { timeoutMs });
  if (res.code !== 0) throw new Error(`swebench_cli ${args[0]} failed: ${(res.stderr || "").slice(-400)}`);
  return res.stdout;
}

function loadInstances(only, limit) {
  const rows = readFileSync(DATASET, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let picked = rows;
  if (only.length) picked = rows.filter((r) => only.some((s) => r.instance_id.toLowerCase().includes(s.toLowerCase())));
  picked.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  if (limit > 0) picked = picked.slice(0, limit);
  return picked;
}

const imageFor = (row) => row.image || `swebench/sweb.eval.x86_64.${row.instance_id}:latest`.toLowerCase().replace(/__/g, "_1776_");

async function ensureImage(image) {
  const have = await docker(["image", "inspect", image], { timeoutMs: 30_000 });
  if (have.code === 0) return { pulled: false };
  if (await loadFromCache(docker, image)) return { pulled: false };
  console.log(`  pulling ${image}…`);
  const res = await docker(["pull", image], { timeoutMs: 1_800_000 });
  if (res.code !== 0) throw new Error(`docker pull failed: ${(res.stderr || res.stdout || "").slice(-300)}`);
  // Fill the cache in the background of the rollout: the image is here now,
  // and the next run wants it without the download.
  await saveToCache(docker, image);
  return { pulled: true };
}

async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Replace loopback with the name containers use to reach the host. */
const containerModelUrl = (url) => url.replace("//127.0.0.1", "//host.docker.internal").replace("//localhost", "//host.docker.internal");

/**
 * Per-rollout labeled URL: the proxy reads agent/task from the path prefix, so
 * calls stay attributed even when two rollouts share the proxy concurrently
 * (a mutable proxy-wide label would scramble them). repeat is always 1 here.
 */
const labeledModelUrl = (modelUrl, agent, instanceId) =>
  containerModelUrl(`${modelUrl}/_lbl/${encodeURIComponent(agent)}/${encodeURIComponent(instanceId)}/1`);

/** Server launch env mirrors what the eval script's `conda activate testbed` gives. */
function startServer(container) {
  const script = [
    "cd /bundle",
    "export PORT=18741 HOST=0.0.0.0 DATABASE_PATH=/tmp/acpio-bench.db",
    "export PATH=/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:$PATH",
    "export CONDA_DEFAULT_ENV=testbed CONDA_PREFIX=/opt/miniconda3/envs/testbed",
    "exec ./node/bin/node apps/server/dist/index.js > /tmp/acpio-server.log 2>&1",
  ].join(" && ");
  return dockerExec(container, script, 30_000);
}

async function api(base, method, p, body) {
  // Port-mapped requests arrive from the docker gateway, not loopback; the
  // server honors x-real-ip behind a trusted proxy (trustProxy: true), and
  // this runner is exactly that: a local, trusted driver of the container.
  const res = await fetch(base + p, {
    method,
    headers: { "x-real-ip": "127.0.0.1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

/** Poll the session like bench/lib/builtin-agent.mjs does, collect the same stats.
 * One turn, no nudges: when the model stops calling tools, the session is done —
 * continuation tricks would be the benchmark papering over the agent's behavior. */
async function driveSession(base, prompt, timeoutMs, transcriptPath) {
  const t0 = Date.now();
  const session = await api(base, "POST", "/api/sessions", { provider: "builtin", cwd: "/testbed", mode: "agent" });
  const deadline = t0 + timeoutMs;
  await api(base, "POST", `/api/sessions/${session.id}/prompt`, { text: prompt });

  let detail = null;
  let sawRunning = false;
  for (;;) {
    detail = await api(base, "GET", `/api/sessions/${session.id}`);
    if (detail.status === "running") sawRunning = true;
    else if (sawRunning || Date.now() - t0 > 5000) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (detail?.status === "running") {
    try {
      await api(base, "POST", `/api/sessions/${session.id}/cancel`);
    } catch {}
    const idleBy = Date.now() + 120_000;
    while (Date.now() < idleBy) {
      try {
        detail = await api(base, "GET", `/api/sessions/${session.id}`);
      } catch {
        break;
      }
      if (detail.status !== "running") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const parts = detail?.messages?.flatMap((m) => m.parts ?? []) ?? [];
  const toolNames = {};
  let toolErrors = 0;
  for (const p of parts.filter((p) => p.type === "tool_call")) {
    const title = String(p.payload?.title ?? "");
    const name = String(p.payload?.raw?.toolName ?? p.payload?.toolName ?? title.split(/\s+/)[0] ?? "") || "?";
    toolNames[name] = (toolNames[name] || 0) + 1;
    if (p.payload?.status === "failed") toolErrors += 1;
  }
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage = detail?.usage ?? null;
  const lastAssistant = [...(detail?.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => String(p.payload?.text ?? ""))
    .join("");
  // The full transcript (every message and tool call the session recorded) is
  // the raw material for post-run analysis; the container that holds the DB
  // gets deleted, so persist it through the API while it is alive.
  try {
    if (transcriptPath && detail?.messages) {
      mkdirSync(path.dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, JSON.stringify({ sessionId: session.id, messages: detail.messages }, null, 2));
    }
  } catch {}
  return {
    sessionId: session.id,
    serverStatus: detail?.status ?? "",
    timedOut: Date.now() > deadline,
    toolCalls: parts.filter((p) => p.type === "tool_call").length,
    toolErrors,
    toolNames,
    tokensIn: num(usage?.inputTokens),
    tokensOut: num(usage?.outputTokens),
    tokensCached: num(usage?.cachedInputTokens),
    finalText: finalText.slice(-2000),
    wallMs: Date.now() - t0,
  };
}

/** Drop diff blocks with no real hunks (mode-only churn: some sweb images
 * ship the worktree 777, and `git add -A` stages those modes no matter what
 * core.fileMode says — only the @@ hunks are the agent's actual work). */
const stripModeOnlyBlocks = (patch) =>
  patch
    .split(/^diff --git /m)
    .filter((block) => {
      if (!block.trim()) return false;
      return /\n@@|Binary files /.test("\n" + block);
    })
    .map((block) => "diff --git " + block)
    .join("");

async function extractPatch(container, baseCommit) {
  // Build junk (pip install -e . creates build/, setuptools drops egg-info)
  // is excluded from the reported patch: grading resets test files and reads
  // only the suite result, so the noise would only poison patch-size metrics.
  const res = await dockerExec(
    container,
    `git config --global --add safe.directory /testbed && cd /testbed && git add -A && ` +
      `git -c core.fileMode=false diff --cached ${baseCommit} -- . ':(exclude)build' ':(exclude)**/__pycache__' ` +
      `':(exclude)**/*.egg-info' ':(exclude).pytest_cache' ':(exclude)**/.pytest_cache'`,
    120_000,
  );
  if (res.code !== 0) throw new Error(`patch extraction failed: ${(res.stderr || "").slice(-300)}`);
  return stripModeOnlyBlocks(res.stdout ?? "");
}

const patchFiles = (patch) => [...new Set([...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]))];

/** The grader's test patch must apply onto a tree that agrees with base for
 * the files it touches. The eval script resets those paths itself, but only
 * for files that exist at base: an agent fixture created at a test-patch path
 * survives the reset and kills `git apply` — the run then fails invisibly,
 * with a green rollout and the new tests never installed (sphinx-8269, twice).
 * Force every test-patch path back to base here, before patch extraction and
 * eval. Files added by the agent elsewhere are left alone: only grader-owned
 * paths are reset, never the fix itself. */
async function resetTestPatchPaths(container, row) {
  const files = patchFiles(row.test_patch);
  if (!files.length) return;
  const list = files.map((f) => `'${f}'`).join(" ");
  const script =
    `cd /testbed || exit 1; for f in ${list}; do ` +
    `if git cat-file -e ${row.base_commit}:"$f" 2>/dev/null; then ` +
    `git diff --quiet ${row.base_commit} -- "$f" || { git checkout ${row.base_commit} -- "$f" && echo "reset(base): $f"; }; ` +
    `elif [ -e "$f" ]; then git rm -f --cached -q "$f" >/dev/null 2>&1; rm -f "$f" && echo "reset(new): $f"; fi; done`;
  const res = await dockerExec(container, script, 60_000);
  const lines = (res.stdout || "").trim();
  if (lines) console.log(`  ${row.instance_id}: test-patch paths reset to base\n${lines.split("\n").map((l) => `    ${l}`).join("\n")}`);
}

/** Where each CLI agent lives inside the container (see prepare-agent-bundle.mjs). */
const CONTAINER_AGENT = {
  pi: { cmd: "/bundle/node/bin/node", entry: "/bundle/agents/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
  omp: { cmd: "/bundle/bun", entry: "/bundle/agents/omp/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" },
};

/**
 * Each CLI gates its native session header on the provider name: omp wants
 * `opencode-zen`, pi wants `opencode` (or an opencode.ai host, which the proxy
 * can't be). The provider slug is a local alias anyway — same endpoint, same
 * model id — so each agent gets the name that turns on its own mechanism.
 */
const AGENT_PROVIDER_ALIAS = { pi: "opencode", omp: "opencode-zen" };

/** Stage the provider config a CLI agent needs and docker cp it in. */
async function stageCliAgentConfig(container, agent, runDir, modelUrl, opts, instanceId) {
  const provider = AGENT_PROVIDER_ALIAS[agent] ?? opts.provider;
  const cfg = { provider, baseUrl: labeledModelUrl(modelUrl, agent, instanceId), apiKey: opts.builtinKey, modelId: opts.modelId, contextWindow: opts.contextWindow };
  if (agent === "pi") {
    const dir = path.join(runDir, "agents", "pi");
    ensurePiModel(dir, cfg);
    await dockerOk(["exec", container, "mkdir", "-p", "/opt/pi-agent"], { timeoutMs: 30_000 });
    await dockerOk(["cp", path.join(dir, "models.json"), `${container}:/opt/pi-agent/models.json`], { timeoutMs: 60_000 });
    // ensurePiModel also wrote extensions/bash-timeout.js (default per-command
    // bash ceiling); pi discovers extensions in <agentDir>/extensions.
    await dockerOk(["cp", path.join(dir, "extensions"), `${container}:/opt/pi-agent/extensions`], { timeoutMs: 60_000 });
    return ["-e", "PI_CODING_AGENT_DIR=/opt/pi-agent", "-e", "PI_OFFLINE=1"];
  }
  if (agent === "omp") {
    const home = path.join(runDir, "agents", "omp", "home");
    ensureOmpModel(ompProfile(), cfg, path.join(home, ".omp", "profiles"));
    await dockerOk(["cp", path.join(home, ".omp"), `${container}:/root/.omp`], { timeoutMs: 60_000 });
    return [];
  }
  throw new Error(`not a cli agent: ${agent}`);
}

/** pi/omp in --mode json: same flags as bench/lib/cli-agent.mjs, exec'd in the container. */
async function runCliAgentInContainer(container, agent, { prompt, runDir, timeoutMs, modelUrl, opts, tag, instanceId }) {
  const envFlags = await stageCliAgentConfig(container, agent, runDir, modelUrl, opts, instanceId);
  const { cmd, entry } = CONTAINER_AGENT[agent];
  const argv = [cmd, entry, ...agentArgs(agent, { prompt, provider: AGENT_PROVIDER_ALIAS[agent] ?? opts.provider, modelId: opts.modelId })];
  const res = await runProcess("docker", ["exec", "-w", "/testbed", ...envFlags, container, ...argv], { timeoutMs, maxStdout: 16_000_000 });
  // Raw event stream: every tool call and message the harness printed, one
  // JSON object per line — the action history for later analysis.
  try {
    mkdirSync(path.join(runDir, "transcripts"), { recursive: true });
    writeFileSync(path.join(runDir, "transcripts", `${tag}.events.jsonl`), res.stdout || "");
  } catch {}
  return {
    ...summarizeAgentStream(res.stdout),
    wallMs: res.wallMs,
    exitCode: res.code,
    timedOut: res.timedOut,
    stderrTail: (res.stderr || "").trim().slice(-1500),
  };
}

async function runEval(container, row, runDir, opts, tag) {
  const rowsDir = path.join(runDir, "rows");
  const logsDir = path.join(runDir, "logs");
  mkdirSync(rowsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  const id = row.instance_id;
  const rowFile = path.join(rowsDir, `${tag}.json`);
  writeFileSync(rowFile, JSON.stringify(row, null, 2));

  const spec = await pythonCli(["spec", rowFile], 120_000);
  const evalScript = path.join(logsDir, `${tag}.eval.sh`);
  // Defensive CRLF strip: a \r turns every bash line into `$'...\\r'`.
  writeFileSync(evalScript, spec.replace(/\r\n/g, "\n"));
  await dockerOk(["cp", evalScript, `${container}:/eval.sh`], { timeoutMs: 60_000 });

  const t0 = Date.now();
  // `timeout` inside the container so a budget overrun actually stops the test
  // run (killing the docker client alone would leave pytest running); the outer
  // ceiling is just the docker-call guard.
  const secs = Math.ceil(opts.evalTimeoutMs / 1000) + 60;
  const run = await dockerExec(
    container,
    `timeout -k 30 ${secs} bash /eval.sh > /tmp/test_output.log 2>&1; echo EXIT:$?`,
    opts.evalTimeoutMs + 180_000,
  );
  const evalTimedOut = run.timedOut || /EXIT:$/.test((run.stdout || "").trim().split("\n").pop() ?? "");
  const logFile = path.join(logsDir, `${tag}.log`);
  await docker(["cp", `${container}:/tmp/test_output.log`, logFile], { timeoutMs: 120_000 });

  const grade = JSON.parse((await pythonCli(["grade", rowFile, logFile], 300_000)).trim().split("\n").pop());
  return { ...grade, evalMs: Date.now() - t0, evalTimedOut, evalExit: run.code };
}

/** One instance: image pulled once, then a fresh container per agent — the
 * tree must be at the base commit for every harness under test. */
async function runInstance(row, idx, stamp, runDir, opts, modelUrl, proxy) {
  const image = imageFor(row);
  try {
    await ensureImage(image);
  } catch (err) {
    return opts.agents.map((agent) => ({
      agent,
      instanceId: row.instance_id,
      repo: row.repo,
      version: row.version,
      image,
      ok: false,
      resolved: false,
      status: "ERROR",
      wallMs: 0,
      error: String(err.message ?? err).slice(0, 2000),
    }));
  }
  const recs = [];
  for (const agent of opts.agents) {
    recs.push(await runAgentInstance(agent, row, idx, stamp, runDir, opts, modelUrl, image, proxy));
  }
  if (!opts.keepImages) await docker(["rmi", image], { timeoutMs: 600_000 }).catch(() => {});
  return recs;
}

async function runAgentInstance(agent, row, idx, stamp, runDir, opts, modelUrl, image, proxy) {
  const id = row.instance_id;
  const tag = `${agent}-${id}`;
  const container = `swe-${stamp}-${idx}-${agent}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  const rec = { agent, instanceId: id, repo: row.repo, version: row.version, image };
  proxy?.setLabel({ agent, task: id, repeat: 1 });
  let cleanup = async () => {};
  try {
    await dockerOk(
      ["run", "-d", "--init", "--entrypoint", "/bin/bash", "--name", container, "-p", `127.0.0.1:${port}:${SERVER_PORT}`, image, "-c", "sleep infinity"],
      { timeoutMs: 120_000 },
    );
    cleanup = async () => {
      // The server writes its own log inside the container — the only place
      // an in-turn session error leaves a stack. Keep it before the rm.
      await docker(["cp", `${container}:/tmp/acpio-server.log`, path.join(runDir, "logs", `${tag}.server.log`)], { timeoutMs: 60_000 }).catch(() => {});
      if (opts.keep) return;
      await docker(["rm", "-f", container], { timeoutMs: 120_000 }).catch(() => {});
    };

    // The bundle carries whatever the rollout needs: the acpio server for
    // builtin, node/bun + the CLI packages for pi/omp.
    await dockerOk(["cp", BUNDLE, `${container}:/bundle.tgz`], { timeoutMs: 900_000 });
    await dockerOk(["exec", container, "tar", "-xzf", "/bundle.tgz", "-C", "/"], { timeoutMs: 300_000 });

    if (opts.gold) {
      const goldFile = path.join(runDir, "rows", `${id}.gold.patch`);
      mkdirSync(path.dirname(goldFile), { recursive: true });
      writeFileSync(goldFile, row.patch);
      await dockerOk(["cp", goldFile, `${container}:/tmp/gold.patch`], { timeoutMs: 60_000 });
      const apply = await dockerExec(container, "cd /testbed && git apply /tmp/gold.patch", 60_000);
      if (apply.code !== 0) throw new Error(`gold patch failed to apply: ${(apply.stderr || "").slice(-300)}`);
    } else if (agent === "builtin") {
      await startServer(container);
      if (!(await waitForHealth(base, 90_000))) {
        const log = await dockerExec(container, "tail -c 2000 /tmp/acpio-server.log 2>/dev/null", 15_000).catch(() => ({ stdout: "" }));
        throw new Error(`acpio server did not start: ${log.stdout || "(no log)"}`);
      }
      await api(base, "PUT", "/api/settings", {
        locale: "en",
        defaultProvider: "builtin",
        defaultMode: "agent",
        permissionPolicy: "always",
        builtinProviders: [
          {
            id: "builtin",
            name: "builtin",
            url: labeledModelUrl(modelUrl, agent, id),
            apiKey: opts.builtinKey,
            // The agent stamps its own chat id — one task, one stable session
            // key for the provider's routing/cache (the proxy only backfills
            // the header for CLIs that don't send it).
            headers: [{ name: "x-opencode-session", value: "acpio-{{sessionId}}" }],
            models: [{ id: opts.modelId, label: opts.modelId, contextWindow: opts.contextWindow, enabled: true }],
          },
        ],
      });
      const probe = await api(base, "POST", "/api/agent/probe", { provider: "builtin" });
      if (!probe?.ok) throw new Error(`builtin probe failed: ${probe?.message ?? "unknown"}`);
      rec.metrics = await driveSession(base, opts.prompt(row), opts.timeoutMs, path.join(runDir, "transcripts", `${tag}.json`));
    } else if (CONTAINER_AGENT[agent]) {
      rec.metrics = await runCliAgentInContainer(container, agent, {
        prompt: opts.prompt(row),
        runDir,
        timeoutMs: opts.timeoutMs,
        modelUrl,
        opts,
        tag,
        instanceId: id,
      });
    } else {
      throw new Error(`unknown agent: ${agent}`);
    }

    await resetTestPatchPaths(container, row);
    rec.patch = await extractPatch(container, row.base_commit);
    rec.patchBytes = rec.patch.length;
    rec.patchFiles = patchFiles(rec.patch);
    const patchesDir = path.join(runDir, "patches");
    mkdirSync(patchesDir, { recursive: true });
    writeFileSync(path.join(patchesDir, `${tag}.patch`), rec.patch);
    delete rec.patch;

    if (opts.noEval) {
      rec.resolved = null;
      rec.status = "SKIPPED_EVAL";
    } else {
      const verdict = await runEval(container, row, runDir, opts, tag);
      rec.resolved = verdict.resolved;
      rec.status = verdict.status;
      rec.f2p = verdict.report?.FAIL_TO_PASS ?? null;
      rec.p2p = verdict.report?.PASS_TO_PASS ?? null;
      rec.evalMs = verdict.evalMs;
      rec.evalTimedOut = verdict.evalTimedOut;
      mkdirSync(path.join(runDir, "reports"), { recursive: true });
      writeFileSync(path.join(runDir, "reports", `${tag}.json`), JSON.stringify(verdict.report, null, 2));
    }
    rec.ok = rec.resolved === true;
    rec.error = null;
  } catch (err) {
    rec.ok = false;
    rec.resolved = rec.resolved ?? false;
    rec.status = rec.status ?? "ERROR";
    rec.error = String(err.message ?? err).slice(0, 2000);
  } finally {
    rec.wallMs = Date.now() - t0;
    await cleanup();
  }
  return rec;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "-");

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const slash = opts.model.indexOf("/");
  if (slash < 1) throw new Error(`--model must be <provider>/<id>, got "${opts.model}"`);
  opts.provider = opts.model.slice(0, slash);
  opts.modelId = opts.model.slice(slash + 1);

  const instances = loadInstances(opts.instances, opts.limit);
  if (!instances.length) throw new Error("no instances matched — check --instances / dataset (bench/swe/fetch-dataset.mjs)");
  const knownAgents = ["builtin", ...Object.keys(CONTAINER_AGENT)];
  const bad = opts.agents.filter((a) => !knownAgents.includes(a));
  if (bad.length) throw new Error(`unknown --agents: ${bad.join(", ")} (known: ${knownAgents.join(", ")})`);
  if (!opts.gold && !exists(BUNDLE)) {
    throw new Error(`missing ${BUNDLE}\nbuild it first: node bench/swe/prepare-agent-bundle.mjs`);
  }
  opts.prompt = opts.promptFile
    ? (row) => readFileSync(opts.promptFile, "utf8").replace("{problem}", row.problem_statement)
    : (row) => PROMPT_TEMPLATE.replace("{problem}", row.problem_statement);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(WORK, `swe-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  let proxy = null;
  if (opts.proxy) {
    proxy = new LlmProxy({ upstream: opts.builtinUrl, outDir: opts.out, stamp: `swe-${stamp}`, dump: opts.proxyDump, verbose: opts.proxyVerbose, sessionHeader: opts.sessionHeader });
    await proxy.start();
    console.log(`proxy: ${proxy.base} -> ${opts.builtinUrl}`);
  }
  const modelUrl = proxy ? proxy.base : opts.builtinUrl;

  console.log(
    `swe-bench verified: ${instances.length} instance(s) × ${opts.agents.join("+")} × ${opts.provider}/${opts.modelId}  concurrency=${opts.concurrency}${opts.gold ? "  [GOLD self-test]" : ""}${opts.noEval ? "  [no eval]" : ""}\n`,
  );

  const resultsFile = path.join(opts.out, `swe-${stamp}.jsonl`);
  const rows = [];
  let done = 0;
  const total = instances.length * opts.agents.length;
  const runStart = Date.now();
  const work = instances.map((row, i) => ({ row, i }));
  const workers = Array.from({ length: Math.min(opts.concurrency, work.length) }, async () => {
    for (;;) {
      const item = work.shift();
      if (!item) break;
      const { row, i } = item;
      const recs = await runInstance(row, i, stamp, runDir, opts, modelUrl, proxy);
      for (const rec of recs) {
        rows.push(rec);
        done += 1;
        appendFileSync(resultsFile, JSON.stringify(rec) + "\n");
        appendLedger(opts, stamp, rec);
        console.log(
          `[${done}/${total}] ${rec.ok ? "RESOLVED" : rec.resolved === false ? "FAILED  " : "NO-EVAL "}  ${pad(rec.agent, 8)} ${pad(row.instance_id, 40)}  ${Math.round(rec.wallMs / 1000)}s  patch=${num(rec.patchBytes)}B  ${rec.error ? `error: ${rec.error.slice(0, 120)}` : ""}`,
        );
      }
    }
  });
  await Promise.all(workers);
  const runWallMs = Date.now() - runStart;
  const diagnostics = proxy?.summary() ?? [];

  const summary = renderSummary(opts, instances, rows, stamp, diagnostics, runWallMs);
  const summaryFile = path.join(opts.out, `swe-${stamp}.md`);
  writeFileSync(summaryFile, summary);
  console.log(`\n${resultsFile}\n${summaryFile}`);
  if (proxy) {
    const callsFile = proxy.write();
    console.log(`${callsFile}  (${proxy.calls.length} model calls)`);
  }
  const resolved = rows.filter((r) => r.ok).length;
  const graded = rows.filter((r) => r.resolved !== null && r.resolved !== undefined).length;
  console.log(`\nRESOLVED ${resolved}/${graded || rows.length}${rows.some((r) => r.error) ? `  (${rows.filter((r) => r.error).length} errored)` : ""}`);
  for (const agent of opts.agents) {
    const rs = rows.filter((r) => r.agent === agent);
    if (!rs.length) continue;
    console.log(`  ${pad(agent, 8)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
  }
  console.log(`\ntotal run time: ${fmtDur(runWallMs)} (incl image pulls, rollouts, eval, grading)`);
  for (const [agent, t] of Object.entries(timingStats(rows))) {
    console.log(`  ${pad(agent, 8)} rollout avg ${Math.round(t.rolloutAvg / 1000)}s / med ${Math.round(t.rolloutMed / 1000)}s / max ${Math.round(t.rolloutMax / 1000)}s, eval avg ${Math.round(t.evalAvg / 1000)}s, wall total ${fmtDur(t.wallTotal)}`);
  }
  appendRunIndex(opts, stamp, rows, diagnostics, runWallMs);
  proxy?.stop();
}

/** Per-agent timing aggregates over the finished rows (all runs matter: errored too). */
function timingStats(rows) {
  const med = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)];
  };
  const stats = {};
  for (const r of rows) {
    const t = (stats[r.agent] = stats[r.agent] || { n: 0, wallTotal: 0, rolloutSum: 0, rolloutMax: 0, evalSum: 0 });
    t.n += 1;
    t.wallTotal += r.wallMs || 0;
    t.rolloutSum += r.metrics?.wallMs ?? 0;
    t.rolloutMax = Math.max(t.rolloutMax, r.metrics?.wallMs ?? 0);
    t.evalSum += r.evalMs ?? 0;
  }
  for (const [agent, t] of Object.entries(stats)) {
    const rs = rows.filter((r) => r.agent === agent);
    const rollouts = rs.map((r) => r.metrics?.wallMs ?? 0).filter((n) => n > 0);
    t.rolloutAvg = t.rolloutSum / Math.max(1, rollouts.length);
    t.rolloutMed = med(rollouts);
    t.rolloutMax = Math.max(t.rolloutMax, ...rollouts, 0);
    t.evalAvg = t.evalSum / Math.max(1, rs.filter((r) => r.evalMs != null).length);
  }
  return stats;
}

const fmtDur = (ms) => (ms >= 90_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s` : `${Math.round(ms / 1000)}s`);

/** One line per run in swe-runs.jsonl — the run-level index future analysis
 * reads first; instance detail lives in swe-all-runs.jsonl and the stamps. */
function appendRunIndex(opts, stamp, rows, diagnostics, runWallMs) {
  const wire = {};
  for (const d of diagnostics) {
    const w = (wire[d.agent] = wire[d.agent] || { calls: 0, prompt: 0, cached: 0, completion: 0 });
    w.calls += d.calls;
    w.prompt += d.promptTokens ?? 0;
    w.cached += d.cachedTokens ?? 0;
    w.completion += d.completionTokens ?? 0;
  }
  appendFileSync(
    path.join(opts.out, "swe-runs.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      stamp,
      model: opts.model,
      agents: opts.agents,
      gold: opts.gold || undefined,
      noEval: opts.noEval || undefined,
      concurrency: opts.concurrency,
      pairs: rows.length,
      resolved: rows.filter((r) => r.ok).length,
      failed: rows.filter((r) => r.resolved === false).length,
      errored: rows.filter((r) => r.error).length,
      runWallMs,
      rolloutSumMs: rows.reduce((n, r) => n + (r.metrics?.wallMs ?? 0), 0),
      evalSumMs: rows.reduce((n, r) => n + (r.evalMs ?? 0), 0),
      wire,
    }) + "\n",
  );
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function appendLedger(opts, stamp, rec) {
  appendFileSync(
    path.join(opts.out, "swe-all-runs.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      stamp,
      model: opts.model,
      agent: rec.agent,
      instance: rec.instanceId,
      repo: rec.repo,
      resolved: rec.resolved,
      status: rec.status,
      wallMs: rec.wallMs,
      rolloutMs: rec.metrics?.wallMs ?? null,
      evalMs: rec.evalMs ?? null,
      modelCalls: rec.metrics?.modelCalls ?? null,
      toolCalls: rec.metrics?.toolCalls ?? null,
      toolErrors: rec.metrics?.toolErrors ?? null,
      tokensIn: rec.metrics?.tokensIn ?? null,
      tokensOut: rec.metrics?.tokensOut ?? null,
      tokensCached: rec.metrics?.tokensCached ?? null,
      patchBytes: rec.patchBytes ?? null,
      error: rec.error,
      gold: opts.gold || undefined,
    }) + "\n",
  );
}

function renderSummary(opts, instances, rows, stamp, diagnostics = [], runWallMs = 0) {
  // Proxy numbers are the wire truth (per agent label); harness self-reports
  // fill in only where the proxy saw nothing — they disagree, pi counted 9 of
  // its 43 calls in the first comparison.
  const byRun = new Map(diagnostics.map((d) => [`${d.agent}\u0000${d.task}\u0000${d.repeat}`, d]));
  const lines = [
    `# SWE-bench Verified — ${new Date().toISOString()}`,
    "",
    `Model: \`${opts.model}\`. Instances: ${instances.length} × agents: ${opts.agents.join(", ")}${opts.gold ? " (GOLD self-test)" : ""}. ` +
      `Rollout: the agent runs inside the official swebench container; eval: dataset eval script graded by the swebench package.`,
    "",
    "| instance | agent | resolved | wall s | rollout s | eval s | model calls | tools | tok in (wire) | cached | uncached | tok out (wire) | patch B | files | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const mark = r.resolved === true ? "✅" : r.resolved === false ? "❌" : "—";
    const d = byRun.get(`${r.agent}\u0000${r.instanceId}\u00001`);
    const tokIn = d?.promptTokens ?? r.metrics?.tokensIn ?? null;
    const tokCached = d?.cachedTokens ?? r.metrics?.tokensCached ?? 0;
    const tokOut = d?.completionTokens ?? r.metrics?.tokensOut ?? null;
    const note = r.error ? r.error.slice(0, 100) : r.evalTimedOut ? "eval timeout" : r.metrics?.timedOut ? "rollout timeout" : r.resolved === false ? r.status : "";
    lines.push(
      `| ${r.instanceId} | ${r.agent} | ${mark} | ${Math.round(r.wallMs / 1000)} | ${r.metrics ? Math.round(r.metrics.wallMs / 1000) : "-"} | ${r.evalMs ? Math.round(r.evalMs / 1000) : "-"} | ${d?.calls ?? r.metrics?.modelCalls ?? "-"} | ${r.metrics?.toolCalls ?? "-"} | ${num(tokIn)} | ${num(tokCached)} | ${num(tokIn == null ? null : tokIn - tokCached)} | ${num(tokOut)} | ${num(r.patchBytes)} | ${r.patchFiles?.length ?? "-"} | ${note} |`,
    );
  }
  const fails = rows.filter((r) => !r.ok);
  if (fails.length) {
    lines.push("", "## Failures", "");
    for (const r of fails) {
      const f2p = r.f2p;
      const detail = f2p ? `F2P failed ${Object.values(f2p).filter((s) => s !== "PASS").length}/${Object.keys(f2p).length}` : r.error ?? "";
      lines.push(`- **${r.instanceId} / ${r.agent}**: ${detail}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`);
    }
  }

  // Timing aggregates: per-agent rollout/eval stats and the run's total wall
  // time. Errored rows are kept in the averages — a crashed rollout is time
  // spent too, and these tables get compared across iterations.
  lines.push("", "## Timing", "");
  lines.push(`Total run time: ${fmtDur(runWallMs)} (rollout sum ${fmtDur(rows.reduce((n, r) => n + (r.metrics?.wallMs ?? 0), 0))}, eval sum ${fmtDur(rows.reduce((n, r) => n + (r.evalMs ?? 0), 0))}).`, "");
  lines.push("| agent | n | rollout avg s | med s | max s | wall total | eval avg s | tok in (wire) | cache hit % | uncached | tok out (wire) | resolved |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  const wireByAgent = new Map();
  for (const d of diagnostics) {
    const w = wireByAgent.get(d.agent) || { calls: 0, prompt: 0, cached: 0, completion: 0 };
    w.calls += d.calls;
    w.prompt += d.promptTokens ?? 0;
    w.cached += d.cachedTokens ?? 0;
    w.completion += d.completionTokens ?? 0;
    wireByAgent.set(d.agent, w);
  }
  for (const [agent, t] of Object.entries(timingStats(rows))) {
    const rs = rows.filter((r) => r.agent === agent);
    const w = wireByAgent.get(agent) || {};
    const hitPct = w.prompt ? Math.round((100 * (w.cached ?? 0)) / w.prompt) : null;
    lines.push(
      `| ${agent} | ${t.n} | ${Math.round(t.rolloutAvg / 1000)} | ${Math.round(t.rolloutMed / 1000)} | ${Math.round(t.rolloutMax / 1000)} | ${fmtDur(t.wallTotal)} | ${Math.round(t.evalAvg / 1000)} | ${num(w.prompt)} | ${hitPct == null ? "-" : hitPct + "%"} | ${num(w.prompt == null ? null : w.prompt - (w.cached ?? 0))} | ${num(w.completion)} | ${rs.filter((r) => r.ok).length}/${rs.length} |`,
    );
  }
  return lines.join("\n") + "\n";
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
