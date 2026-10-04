// Daily-bench tasks (bench/tasks/) in the SAME sandbox machinery as the SWE
// circuit: the agent bundle, per-slot containers, per-pair wire labels, native
// session headers, hidden verify — only the tasks and their checks differ.
//
//   node bench/run-docker.mjs                                  # all agents × all tasks
//   node bench/run-docker.mjs --agents builtin --concurrency 8
//
// A sandbox image (node:22-bookworm + the unpacked agent bundle) is built once;
// each slot runs a pool container; each pair gets a clean /workspace, its own
// server session (builtin) or exec (pi/omp), and the verifier exec'd inside.
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentArgs, ensureOmpModel, ensurePiModel, ompProfile } from "./lib/cli-agent.mjs";
import { summarizeAgentStream } from "./lib/jsonl.mjs";
import { applyFaults } from "./lib/faults.mjs";
import { LlmProxy } from "./lib/proxy.mjs";
import { runProcess } from "./lib/util.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ROOT = path.join(REPO, "bench", "tasks");
const CACHE = path.join(REPO, "bench", ".cache");
const BUNDLE_TGZ = path.join(CACHE, "swe-agent-bundle.tar.gz");
const SANDBOX_IMAGE = "acpio-daily-sandbox";
const SERVER_PORT = 18741;

function providerDefaults() {
  try {
    const p = JSON.parse(readFileSync(path.join(CACHE, "swe-provider.json"), "utf8"));
    return { url: p.url, key: p.key, model: p.model };
  } catch {
    return { url: process.env.BENCH_BASE_URL || "http://api.ai.dev.imdomain/v1", key: process.env.BENCH_API_KEY || "no", model: "im/im-llm" };
  }
}

/** Each CLI turns its native session header on by provider name. */
const AGENT_PROVIDER_ALIAS = { pi: "opencode", omp: "opencode-zen" };
/** Where each CLI's bundle entry lives inside the sandbox. */
const CONTAINER_AGENT = {
  pi: { cmd: "/bundle/node/bin/node", entry: "/bundle/agents/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" },
  omp: { cmd: "/bundle/bun", entry: "/bundle/agents/omp/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" },
};

function parseArgs(argv) {
  const defaults = providerDefaults();
  const out = {
    agents: ["builtin", "pi", "omp"],
    tasks: null,
    tasksRoot: [path.join(REPO, "bench", "tasks")],
    family: null,
    faults: [],
    repeats: 1,
    model: process.env.BENCH_MODEL || defaults.model,
    builtinUrl: process.env.BENCH_BASE_URL || defaults.url,
    builtinKey: process.env.BENCH_API_KEY || defaults.key,
    contextWindow: Number(process.env.BENCH_CONTEXT_WINDOW || 64000),
    timeoutMs: 300_000,
    concurrency: 4,
    keep: false,
    proxy: true,
    proxyDump: false,
    proxyVerbose: false,
    out: path.join(REPO, "bench", "results"),
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
      case "--tasks": out.tasks = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--tasks-root": out.tasksRoot = take().split(",").map((s) => path.resolve(s.trim())).filter(Boolean); break;
      case "--family": out.family = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--faults": out.faults = take().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--repeats": out.repeats = Math.max(1, Number(take())); break;
      case "--model": out.model = take(); break;
      case "--builtin-url": out.builtinUrl = take(); break;
      case "--builtin-key": out.builtinKey = take(); break;
      case "--context-window": out.contextWindow = Number(take()); break;
      case "--timeout": out.timeoutMs = Number(take()); break;
      case "--concurrency": out.concurrency = Math.max(1, Number(take())); break;
      case "--keep": out.keep = true; break;
      case "--proxy": out.proxy = true; break;
      case "--no-proxy": out.proxy = false; break;
      case "--proxy-dump": out.proxyDump = true; break;
      case "--proxy-verbose": out.proxyVerbose = true; break;
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
      "Daily-bench tasks in the SWE-style sandbox (bundle + containers).",
      "",
      "  node bench/run-docker.mjs [--agents builtin,pi,omp] [--tasks a,b] [--repeats N]",
      "                            [--concurrency N] [--model p/m] [--timeout ms]",
      "",
      "Same proxy rules and session headers as bench/swe/run-swe.mjs; only the",
      "tasks and their hidden verify.mjs differ. Requires the agent bundle:",
      "  node bench/swe/prepare-agent-bundle.mjs",
    ].join("\n"),
  );
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "-");

async function freePort() {
  for (let p = 6400 + Math.floor(Math.random() * 2000); ; p++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
}

async function docker(args, { timeoutMs = 120_000 } = {}) {
  return runProcess("docker", args, { timeoutMs });
}

async function dockerOk(args, opts) {
  const res = await docker(args, opts);
  if (res.code !== 0) throw new Error(`docker ${args[0]} failed (${res.code}): ${(res.stderr || res.stdout || "").slice(-500)}`);
  return res;
}

async function dockerExec(container, cmd, timeoutMs) {
  return docker(["exec", container, "/bin/bash", "-c", cmd], { timeoutMs });
}

async function ensureSandboxImage() {
  const have = await docker(["image", "inspect", SANDBOX_IMAGE], { timeoutMs: 30_000 });
  if (have.code === 0) return;
  if (!exists(BUNDLE_TGZ)) throw new Error(`missing ${BUNDLE_TGZ} — run: node bench/swe/prepare-agent-bundle.mjs`);
  console.log(`building sandbox image ${SANDBOX_IMAGE} (node:22-bookworm + bundle)…`);
  const dockerfile = path.join(CACHE, "swe-sandbox.Dockerfile");
  writeFileSync(
    dockerfile,
    ["FROM node:22-bookworm", `ADD ${path.basename(BUNDLE_TGZ)} /`, 'ENV PATH="/bundle/node/bin:${PATH}"', ""].join("\n"),
  );
  const res = await docker(["build", "-f", dockerfile, "-t", SANDBOX_IMAGE, CACHE], { timeoutMs: 900_000 });
  if (res.code !== 0) throw new Error(`sandbox image build failed: ${(res.stderr || "").slice(-500)}`);
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

const containerModelUrl = (url) => url.replace("//127.0.0.1", "//host.docker.internal").replace("//localhost", "//host.docker.internal");
const labeledUrl = (modelUrl, agent, taskId, rep) =>
  containerModelUrl(`${modelUrl}/_lbl/${encodeURIComponent(agent)}/${encodeURIComponent(taskId)}/${rep}`);

async function api(base, method, p, body) {
  // Port-mapped requests arrive from the docker gateway; the server honors
  // x-real-ip behind a trusted proxy, and this runner is that trusted proxy.
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

// Server start/stop live in script files: a `bash -c '<script>'` that contains
// the server path would be killed by its own pkill (the pattern matches the
// cmdline of the very shell running it).
function writeServerScripts() {
  writeFileSync(
    path.join(CACHE, "start-server.sh"),
    [
      "#!/bin/bash",
      "pkill -f 'apps/server/dist/index.js' 2>/dev/null",
      "rm -f /tmp/acpio-daily.db",
      "cd /bundle",
      "export PORT=18741 HOST=0.0.0.0 DATABASE_PATH=/tmp/acpio-daily.db",
      "exec ./node/bin/node apps/server/dist/index.js > /tmp/acpio-daily.log 2>&1",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(CACHE, "stop-server.sh"),
    ["#!/bin/bash", "pkill -f 'apps/server/dist/index.js' 2>/dev/null", ""].join("\n"),
  );
}

async function startServer(container) {
  await docker(["exec", "-d", container, "/bin/bash", "/tmp/start-server.sh"], { timeoutMs: 30_000 });
}

async function stopServer(container) {
  return dockerExec(container, "/tmp/stop-server.sh", 15_000);
}

async function driveSession(base, prompt, timeoutMs) {
  const t0 = Date.now();
  const session = await api(base, "POST", "/api/sessions", { provider: "builtin", cwd: "/workspace", mode: "agent" });
  await api(base, "POST", `/api/sessions/${session.id}/prompt`, { text: prompt });
  const deadline = t0 + timeoutMs;
  let detail = null;
  let sawRunning = false;
  for (;;) {
    detail = await api(base, "GET", `/api/sessions/${session.id}`);
    if (detail.status === "running") sawRunning = true;
    else if (sawRunning || Date.now() - t0 > 5000) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (detail?.status === "running") {
    try {
      await api(base, "POST", `/api/sessions/${session.id}/cancel`);
    } catch {}
    const idleBy = Date.now() + 60_000;
    while (Date.now() < idleBy) {
      try {
        detail = await api(base, "GET", `/api/sessions/${session.id}`);
      } catch {
        break;
      }
      if (detail.status !== "running") break;
      await new Promise((r) => setTimeout(r, 500));
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
  return {
    toolCalls: parts.filter((p) => p.type === "tool_call").length,
    toolErrors,
    toolNames,
    tokensIn: num(usage?.inputTokens),
    tokensOut: num(usage?.outputTokens),
    tokensCached: num(usage?.cachedInputTokens),
    finalText: finalText.slice(-1500),
    timedOut: Date.now() > deadline,
    wallMs: Date.now() - t0,
  };
}

async function runCliAgentInContainer(container, agent, { prompt, taskDir, timeoutMs, modelUrl, opts, slotIdx }) {
  const provider = AGENT_PROVIDER_ALIAS[agent] ?? opts.provider;
  const url = labeledUrl(modelUrl, agent, taskDir, 1);
  let envFlags = ["-w", "/workspace"];
  if (agent === "pi") {
    // Per-slot dirs: parallel slots would race on a shared config's rmSync.
    const dir = path.join(CACHE, `daily-pi-config-s${slotIdx}`);
    rmSync(dir, { recursive: true, force: true });
    ensurePiModel(dir, { provider, baseUrl: url, apiKey: opts.builtinKey, modelId: opts.modelId, contextWindow: opts.contextWindow });
    await dockerOk(["exec", container, "mkdir", "-p", "/opt/pi-agent"], { timeoutMs: 30_000 });
    await dockerOk(["cp", path.join(dir, "models.json").replace(/\\/g, "/"), `${container}:/opt/pi-agent/models.json`], { timeoutMs: 60_000 });
    // ensurePiModel also wrote extensions/bash-timeout.js (default per-command
    // bash ceiling); pi discovers extensions in <agentDir>/extensions.
    await dockerOk(["cp", path.join(dir, "extensions").replace(/\\/g, "/"), `${container}:/opt/pi-agent/extensions`], { timeoutMs: 60_000 });
    envFlags.push("-e", "PI_CODING_AGENT_DIR=/opt/pi-agent", "-e", "PI_OFFLINE=1");
  } else if (agent === "omp") {
    const home = path.join(CACHE, `daily-omp-home-s${slotIdx}`);
    rmSync(path.join(home, ".omp"), { recursive: true, force: true });
    ensureOmpModel(ompProfile(), { provider, baseUrl: url, apiKey: opts.builtinKey, modelId: opts.modelId, contextWindow: opts.contextWindow }, path.join(home, ".omp", "profiles"));
    // docker cp of a directory onto an existing one nests the copy
    // (/root/.omp/.omp/...) instead of replacing it — the stale models.yml
    // from the first pair on this slot would keep winning. Remove first.
    await dockerOk(["exec", container, "/bin/bash", "-c", "rm -rf /root/.omp"], { timeoutMs: 30_000 });
    await dockerOk(["cp", path.join(home, ".omp").replace(/\\/g, "/"), `${container}:/root/.omp`], { timeoutMs: 60_000 });
  }
  const { cmd, entry } = CONTAINER_AGENT[agent];
  const argv = [cmd, entry, ...agentArgs(agent, { prompt, provider, modelId: opts.modelId })];
  const res = await runProcess("docker", ["exec", ...envFlags, container, ...argv], { timeoutMs, maxStdout: 16_000_000 });
  return {
    ...summarizeAgentStream(res.stdout),
    wallMs: res.wallMs,
    exitCode: res.code,
    timedOut: res.timedOut,
    stderrTail: (res.stderr || "").trim().slice(-1500),
  };
}

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function renderSummary(rows, opts, diagnostics = [], runWallMs = 0) {
  const byAgent = new Map();
  for (const d of diagnostics) {
    const w = byAgent.get(d.agent) || { calls: 0, prompt: 0, cached: 0, completion: 0 };
    w.calls += d.calls;
    w.prompt += d.promptTokens ?? 0;
    w.cached += d.cachedTokens ?? 0;
    w.completion += d.completionTokens ?? 0;
    byAgent.set(d.agent, w);
  }
  const lines = [
    `# Daily bench (docker sandbox) — ${new Date().toISOString()}`,
    "",
    `Model: \`${opts.model}\`. Agents: ${opts.agents.join(", ")}. Same sandbox machinery as the SWE circuit.`,
    "",
    "| agent | pass/runs | wall total | tok in (wire) | cache hit % | uncached | tok out | calls |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const agent of opts.agents) {
    const rs = rows.filter((r) => r.agent === agent);
    if (!rs.length) continue;
    const w = byAgent.get(agent) || {};
    const wall = rs.reduce((n, r) => n + (r.metrics?.wallMs ?? r.wallMs ?? 0), 0);
    const hit = w.prompt ? Math.round((100 * (w.cached ?? 0)) / w.prompt) : null;
    lines.push(
      `| ${agent} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${Math.round(wall / 1000)}s | ${num(w.prompt)} | ${hit == null ? "-" : hit + "%"} | ${num(w.prompt == null ? null : w.prompt - (w.cached ?? 0))} | ${num(w.completion)} | ${w.calls ?? 0} |`,
    );
  }
  lines.push("", `Total run time: ${Math.round(runWallMs / 1000)}s.`, "");
  const fails = rows.filter((r) => !r.ok);
  if (fails.length) {
    lines.push("## Failures", "");
    for (const r of fails) lines.push(`- **${r.agent}/${r.task}**: ${(r.verifyOutput || r.error || "").replace(/\n/g, " ").slice(0, 300)}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const slash = opts.model.indexOf("/");
  if (slash < 1) throw new Error(`--model must be <provider>/<id>, got "${opts.model}"`);
  opts.provider = opts.model.slice(0, slash);
  opts.modelId = opts.model.slice(slash + 1);

  let tasks = [];
  const seen = new Set();
  for (const root of opts.tasksRoot) {
    for (const e of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      if (seen.has(e.name)) continue; // first root wins on id collisions
      seen.add(e.name);
      tasks.push({ dir: path.join(root, e.name), ...JSON.parse(readFileSync(path.join(root, e.name, "task.json"), "utf8")) });
    }
  }
  if (opts.tasks) tasks = tasks.filter((t) => opts.tasks.includes(t.id));
  if (opts.family) tasks = tasks.filter((t) => opts.family.includes(t.family ?? "synthetic"));
  else if (!opts.tasks) tasks = tasks.filter((t) => !["m", "l"].includes(t.horizon)); // long tasks opt in (see README)
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  if (!tasks.length) throw new Error("no tasks selected");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(opts.out, { recursive: true });

  let proxy = null;
  if (opts.proxy) {
    proxy = new LlmProxy({ upstream: opts.builtinUrl, outDir: opts.out, stamp: `docker-${stamp}`, dump: opts.proxyDump, verbose: opts.proxyVerbose });
    await proxy.start();
    console.log(`proxy: ${proxy.base} -> ${opts.builtinUrl}`);
  }
  const modelUrl = proxy ? proxy.base : opts.builtinUrl;

  await ensureSandboxImage();
  writeServerScripts();

  console.log(`daily bench (docker): ${tasks.length} task(s) × ${opts.agents.join("+")} × ${opts.provider}/${opts.modelId}  concurrency=${opts.concurrency}\n`);

  const resultsFile = path.join(opts.out, `docker-${stamp}.jsonl`);
  const rows = [];
  let done = 0;
  const total = opts.agents.length * tasks.length * opts.repeats;
  const runStart = Date.now();

  // Build the pair queue, then C slot containers; each slot runs its pairs
  // sequentially in its own container (clean /workspace per pair).
  const pairs = [];
  for (const agent of opts.agents) {
    for (const task of tasks) {
      for (let rep = 1; rep <= opts.repeats; rep++) pairs.push({ agent, task, rep });
    }
  }
  const C = Math.min(opts.concurrency, pairs.length);
  const slots = Array.from({ length: C }, (_, idx) => ({ idx, container: `daily-${stamp}-s${idx}`, port: null }));

  for (const slot of slots) {
    slot.port = await freePort();
    await dockerOk(
      ["run", "-d", "--init", "--entrypoint", "/bin/bash", "--name", slot.container, "-p", `127.0.0.1:${slot.port}:${SERVER_PORT}`, SANDBOX_IMAGE, "-c", "sleep infinity"],
      { timeoutMs: 120_000 },
    );
    await dockerOk(["cp", path.join(CACHE, "start-server.sh").replace(/\\/g, "/"), `${slot.container}:/tmp/start-server.sh`], { timeoutMs: 60_000 });
    await dockerOk(["cp", path.join(CACHE, "stop-server.sh").replace(/\\/g, "/"), `${slot.container}:/tmp/stop-server.sh`], { timeoutMs: 60_000 });
  }
  const cleanup = async () => {
    for (const slot of slots) {
      if (!opts.keep) await docker(["rm", "-f", slot.container], { timeoutMs: 120_000 }).catch(() => {});
    }
  };

  const runPair = async (pair, slot) => {
    const { agent, task, rep } = pair;
    const container = slot.container;
    const base = `http://127.0.0.1:${slot.port}`;
    const timeoutMs = task.timeoutMs ?? opts.timeoutMs;
    const t0 = Date.now();
    const row = { agent, task: task.id, repeat: rep, ...(opts.faults.length ? { faults: opts.faults } : {}) };
    try {
      await dockerOk(["exec", container, "/bin/bash", "-c", "rm -rf /workspace"], { timeoutMs: 30_000 });
      // Forward slashes: docker cp chokes on mixed Windows separators. Tasks
      // without a fixture start from an empty workspace (agent creates files).
      // Faults are applied to a host staging copy so the task fixture itself
      // stays pristine for the next pair.
      const fixture = path.join(task.dir, "fixture");
      if (exists(fixture)) {
        let copyFrom = fixture;
        if (opts.faults.length) {
          const staging = path.join(CACHE, "fault-staging", `${task.id}-${agent}-r${rep}`);
          rmSync(staging, { recursive: true, force: true });
          cpSync(fixture, staging, { recursive: true });
          await applyFaults(task.dir, staging, opts.faults);
          copyFrom = staging;
        }
        await dockerOk(["cp", copyFrom.replace(/\\/g, "/"), `${container}:/workspace`], { timeoutMs: 60_000 });
      } else {
        await dockerOk(["exec", container, "/bin/bash", "-c", "mkdir -p /workspace"], { timeoutMs: 30_000 });
      }

      if (agent === "builtin") {
        await startServer(container);
        if (!(await waitForHealth(base, 60_000))) {
          const log = await dockerExec(container, "tail -c 1500 /tmp/acpio-daily.log 2>/dev/null", 15_000).catch(() => ({ stdout: "" }));
          throw new Error(`server did not start: ${log.stdout || "(no log)"}`);
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
              url: labeledUrl(modelUrl, agent, task.id, rep),
              apiKey: opts.builtinKey,
              headers: [{ name: "x-opencode-session", value: "acpio-{{sessionId}}" }],
              models: [{ id: opts.modelId, label: opts.modelId, contextWindow: opts.contextWindow, enabled: true }],
            },
          ],
        });
        const probe = await api(base, "POST", "/api/agent/probe", { provider: "builtin" });
        if (!probe?.ok) throw new Error(`probe failed: ${probe?.message ?? "unknown"}`);
        row.metrics = await driveSession(base, task.prompt, timeoutMs);
        await stopServer(container);
      } else if (CONTAINER_AGENT[agent]) {
        row.metrics = await runCliAgentInContainer(container, agent, {
          prompt: task.prompt,
          taskDir: task.id,
          timeoutMs,
          modelUrl,
          opts,
          slotIdx: slot.idx,
        });
      } else {
        throw new Error(`unknown agent: ${agent}`);
      }

      // Hidden verify, exec'd in the same environment the agent worked in.
      await dockerOk(["cp", path.join(task.dir, "verify.mjs"), `${container}:/workspace/verify.mjs`], { timeoutMs: 60_000 });
      const v = await dockerExec(container, "cd /workspace && node verify.mjs 2>&1", 60_000);
      row.ok = v.code === 0;
      row.verifyOutput = ((v.stdout || "") + (v.stderr || "")).trim().slice(-600);
      row.error = null;
    } catch (err) {
      row.ok = false;
      row.error = String(err.message ?? err).slice(0, 1500);
    } finally {
      row.wallMs = Date.now() - t0;
    }
    return row;
  };

  const queue = [...pairs];
  const workers = Array.from({ length: C }, (_, idx) =>
    (async () => {
      for (;;) {
        const pair = queue.shift();
        if (!pair) break;
        const row = await runPair(pair, slots[idx]);
        rows.push(row);
        done += 1;
        appendFileSync(resultsFile, JSON.stringify(row) + "\n");
        console.log(
          `[${done}/${total}] ${row.ok ? "PASS" : "FAIL"}  ${pad(row.agent, 8)} ${pad(row.task, 22)} ${String(Math.round(row.wallMs / 1000)).padStart(4)}s  tools=${num(row.metrics?.toolCalls)}  ${row.error ? "ERR " + row.error.slice(0, 90) : ""}`,
        );
      }
    })(),
  );
  await Promise.all(workers);
  const runWallMs = Date.now() - runStart;
  const diagnostics = proxy?.summary() ?? [];
  await cleanup();
  if (proxy) {
    const callsFile = proxy.write();
    proxy.stop();
    console.log(`${callsFile}  (${proxy.calls.length} model calls)`);
  }

  const summary = renderSummary(rows, opts, diagnostics, runWallMs);
  const summaryFile = path.join(opts.out, `docker-${stamp}.md`);
  writeFileSync(summaryFile, summary);
  console.log(`\n${resultsFile}\n${summaryFile}\n`);
  for (const agent of opts.agents) {
    const rs = rows.filter((r) => r.agent === agent);
    if (rs.length) console.log(`  ${pad(agent, 8)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
  }
  console.log(`\ntotal run time: ${Math.round(runWallMs / 1000)}s (incl sandbox image, ${C} slot containers)`);
  appendLedger(opts, stamp, rows, diagnostics, runWallMs);
}

function appendLedger(opts, stamp, rows, diagnostics, runWallMs) {
  const wire = {};
  for (const d of diagnostics) {
    const w = (wire[d.agent] = wire[d.agent] || { calls: 0, prompt: 0, cached: 0, completion: 0 });
    w.calls += d.calls;
    w.prompt += d.promptTokens ?? 0;
    w.cached += d.cachedTokens ?? 0;
    w.completion += d.completionTokens ?? 0;
  }
  appendFileSync(
    path.join(opts.out, "docker-all-runs.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      stamp,
      model: opts.model,
      agents: opts.agents,
      pairs: rows.length,
      resolved: rows.filter((r) => r.ok).length,
      runWallMs,
      wire,
    }) + "\n",
  );
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
