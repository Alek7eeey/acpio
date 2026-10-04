#!/usr/bin/env node
// Benchmark runner: same task fixture, same model, one fresh workspace per run.
//
//   node bench/run.mjs --agents pi,omp,builtin --tasks fix-sum,fizzbuzz
//   node bench/run.mjs --agents builtin --repeats 3 --keep
//
// Results land as one row per run in bench/results/<stamp>.jsonl.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchServer, runBuiltinAgent, sessionTranscriptHasNul } from "./lib/builtin-agent.mjs";
import { ensureOmpModel, ensurePiModel, ompProfile, runCliAgent } from "./lib/cli-agent.mjs";
import { LlmProxy } from "./lib/proxy.mjs";
import { applyFaults } from "./lib/faults.mjs";
import { changedFiles, makeWorkspace, splitPrompt, verifyWorkspace } from "./lib/util.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ROOT = path.join(REPO, "bench", "tasks");

/** Shared bench defaults: one model across all benchmarks (gitignored config,
 * env and CLI flags override). Same file the SWE runner reads. */
function providerDefaults() {
  try {
    const p = JSON.parse(readFileSync(path.join(REPO, "bench", ".cache", "swe-provider.json"), "utf8"));
    return { url: p.url, key: p.key, model: p.model };
  } catch {
    return { url: process.env.BENCH_BASE_URL || "http://api.ai.dev.imdomain/v1", key: process.env.BENCH_API_KEY || "no", model: "im/im-llm" };
  }
}

/** Each CLI turns its native provider session header on by provider name. */
const AGENT_PROVIDER_ALIAS = { pi: "opencode", omp: "opencode-zen" };

function parseArgs(argv) {
  const defaults = providerDefaults();
  const out = {
    agents: ["pi", "omp", "builtin"],
    tasks: null,
    tasksRoot: [path.join(REPO, "bench", "tasks")],
    family: null,
    faults: [],
    repeats: 1,
    turns: 1,
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
    sessionHeader: process.env.BENCH_SESSION_HEADER || null,
    out: path.join(REPO, "bench", "results"),
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
      case "--turns": out.turns = Math.max(1, Math.min(8, Number(take()) || 1)); break;
      case "--model": out.model = take(); break;
      case "--builtin-url": out.builtinUrl = take(); break;
      case "--builtin-key": out.builtinKey = take(); break;
      case "--context-window": out.contextWindow = Number(take()); break;
      case "--timeout": out.timeoutMs = Number(take()); break;
      case "--concurrency": out.concurrency = Math.max(1, Number(take())); break;
      case "--out": out.out = path.resolve(take()); break;
      case "--keep": out.keep = true; break;
      case "--proxy": out.proxy = true; break;
      case "--no-proxy": out.proxy = false; break;
      case "--proxy-dump": out.proxyDump = true; break;
      case "--proxy-verbose": out.proxyVerbose = true; break;
      case "--session-header": out.sessionHeader = take(); break;
      case "--help": out.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return out;
}

function loadTasks(roots, only, families) {
  const tasks = [];
  const seen = new Set();
  for (const root of roots) {
    const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const e of entries) {
      if (seen.has(e.name)) continue; // first root wins on id collisions
      seen.add(e.name);
      tasks.push({
        dir: path.join(root, e.name),
        ...JSON.parse(readFileSync(path.join(root, e.name, "task.json"), "utf8")),
      });
    }
  }
  let picked = only ? tasks.filter((t) => only.includes(t.id)) : tasks;
  if (families) picked = picked.filter((t) => families.includes(t.family ?? "synthetic"));
  else if (!only) picked = picked.filter((t) => !["m", "l"].includes(t.horizon)); // long tasks opt in (see README)
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

const fmt = (n, digits = 0) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-");
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function logRow(row, done, total) {
  const label = `${row.agent}-${row.task}-r${row.repeat}`;
  console.log(
    `[${done}/${total}] ${row.ok ? "PASS" : "FAIL"}  ${pad(label, 26)} ${String(Math.round(row.wallMs / 1000)).padStart(4)}s  tools=${String(row.toolCalls).padStart(2)}  in=${String(row.tokensIn).padStart(6)}  out=${String(row.tokensOut).padStart(5)}  ${row.timedOut ? "TIMEOUT" : ""}${row.crashed ? `exit=${row.exitCode}` : ""}`,
  );
  if (!row.ok) console.log(`      ↳ ${row.verifyOutput.split("\n").slice(0, 4).join(" | ").slice(0, 300)}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Agent benchmark — same task, same model, fresh workspace per run.",
        "",
        "  node bench/run.mjs [--agents pi,omp,builtin] [--tasks fix-sum,fizzbuzz]",
        "                     [--tasks-root <dir,...>] [--family long,...] [--faults a,b]",
        "                     [--repeats N] [--turns N] [--model <provider>/<id>] [--timeout ms]",
        "                     [--concurrency N] [--builtin-url <url>] [--builtin-key <key>]",
        "                     [--context-window N] [--out <dir>] [--keep]",
        "                     [--no-proxy] [--proxy-dump] [--proxy-verbose]",
        "",
        "Pairs (agent × task × repeat) run on N parallel slots; every pair's",
        "provider URL carries its own wire label. Default model/provider comes",
        "from bench/.cache/swe-provider.json (space-bunny-free), same as the SWE",
        "runner.",
        "",
        "--turns N sends the task prompt to the builtin agent as N user turns",
        "(split at sentence boundaries; a task.json \"prompts\" array wins) in",
        "one session — multi-prompt mode, the only shape where server-side",
        "compaction has a turn boundary to engage. Applies to builtin only.",
        "",
        "Results: bench/results/<stamp>.jsonl and <stamp>.md",
        "         <stamp>.calls.jsonl - every model call as seen by the proxy",
      ].join("\n"),
    );
    return;
  }

  const tasks = loadTasks(opts.tasksRoot, opts.tasks, opts.family);
  if (!tasks.length) throw new Error("no tasks selected");

  const slash = opts.model.indexOf("/");
  if (slash < 1) throw new Error(`--model must be <provider>/<id>, got "${opts.model}"`);
  const provider = opts.model.slice(0, slash);
  const modelId = opts.model.slice(slash + 1);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workRoot = path.join(REPO, "bench", ".work", stamp);
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  console.log(`model: ${provider}/${modelId}   agents: ${opts.agents.join(", ")}   tasks: ${tasks.map((t) => t.id).join(", ")}   repeats: ${opts.repeats}   concurrency: ${opts.concurrency}${opts.turns > 1 ? `   turns: ${opts.turns}` : ""}\n`);
  if (opts.turns > 1 && opts.agents.some((a) => a !== "builtin")) {
    console.warn("note: --turns applies to the builtin agent only; CLI agents still get one prompt.\n");
  }

  // Every agent talks to the proxy, so the wire is captured regardless of what
  // each harness reports about itself. `--no-proxy` restores a direct call.
  let proxy = null;
  if (opts.proxy) {
    proxy = new LlmProxy({
      upstream: opts.builtinUrl,
      outDir: opts.out,
      stamp,
      dump: opts.proxyDump,
      verbose: opts.proxyVerbose,
      sessionHeader: "x-opencode-session",
    });
    await proxy.start();
    console.log(`proxy: ${proxy.base} -> ${opts.builtinUrl}${opts.proxyDump ? " (dumping requests)" : ""}\n`);
  }
  // Per-pair wire attribution: each pair's provider URL carries its label; the
  // proxy reads it from the path (shared mutable labels scramble concurrent
  // runs). The prefix is stripped before forwarding.
  const labeledUrl = (agent, taskId, rep) =>
    `${proxy ? proxy.base : opts.builtinUrl}/_lbl/${encodeURIComponent(agent)}/${encodeURIComponent(taskId)}/${rep}`;

  const piConfigDirs = new Map(); // slot -> dir

  /** One (agent, task, repeat) pair, run on the given slot. */
  const runPair = async (pair, slot) => {
    const { agent, task, rep } = pair;
    const label = `${agent}-${task.id}-r${rep}`;
    const url = labeledUrl(agent, task.id, rep);
    const timeoutMs = task.timeoutMs ?? opts.timeoutMs;
    let result;
    let ws;
    let faults = [];
    let retried = false;
    let retryReason = "";
    let verify = null;
    // Multi-prompt mode (builtin only): a declared "prompts" array in
    // task.json wins, otherwise --turns splits the single prompt at sentence
    // boundaries. Default is one prompt — the plain single-turn session.
    const prompts =
      agent === "builtin" && (task.prompts?.length || opts.turns > 1)
        ? task.prompts?.length
          ? task.prompts
          : splitPrompt(task.prompt, opts.turns)
        : null;
    for (;;) {
      ws = makeWorkspace(task.dir, workRoot, label);
      // Faults are strictly additive mutations of the workspace before the
      // agent starts; a retry gets a fresh workspace and the same faults.
      // `--faults all` picks up each task's own declared list (task.json
      // "faults"), so a family-wide faulted run is one command; tasks without
      // declared faults run clean instead of erroring the pair.
      faults = await applyFaults(task.dir, ws, opts.faults.includes("all") ? (task.faults ?? []) : opts.faults);
      let piConfigDir;
      try {
        if (agent === "builtin") {
          if (!slot.server) {
            slot.server = new BenchServer({
              repo: REPO,
              stateDir: path.join(workRoot, `server-s${slot.idx}`),
              provider: { provider: AGENT_PROVIDER_ALIAS[agent] ?? provider, baseUrl: url, apiKey: opts.builtinKey, modelId, contextWindow: opts.contextWindow },
              headers: [{ name: "x-opencode-session", value: "acpio-{{sessionId}}" }],
            });
            await slot.server.start();
            console.log(`builtin server (slot ${slot.idx}) up on ${slot.server.base}`);
          } else {
            // Same server, next pair: relabel so the wire attribution follows.
            await slot.server.configure(url);
          }
          result = await runBuiltinAgent(slot.server, { task, ws, timeoutMs, prompts });
        } else {
          const providerSlug = AGENT_PROVIDER_ALIAS[agent] ?? provider;
          if (agent === "pi") {
            if (!piConfigDirs.has(slot.idx)) piConfigDirs.set(slot.idx, path.join(workRoot, `pi-s${slot.idx}`));
            piConfigDir = piConfigDirs.get(slot.idx);
            ensurePiModel(piConfigDir, { provider: providerSlug, baseUrl: url, apiKey: opts.builtinKey, modelId, contextWindow: opts.contextWindow });
          }
          if (agent === "omp") {
            ensureOmpModel(ompProfile(), { provider: providerSlug, baseUrl: url, apiKey: opts.builtinKey, modelId, contextWindow: opts.contextWindow });
          }
          result = await runCliAgent(agent, { task, ws, provider: providerSlug, modelId, timeoutMs, piConfigDir });
        }
      } catch (err) {
        result = {
          toolCalls: 0, toolErrors: 0, toolNames: {}, tokensIn: 0, tokensOut: 0,
          tokensTotal: 0, tokensCached: 0, contextTokens: 0, cost: 0, finalText: "", stopReason: "",
          wallMs: 0, exitCode: null, timedOut: false, stderrTail: String(err),
        };
      }
      // Artifact signatures (§7): the endpoint occasionally ends a session
      // looking honest while nothing honest happened — a timeout wall with a
      // handful of calls (start or mid-session stall), an instant finish with
      // no tool use at all, or NUL bytes inside tool arguments (silent stream
      // corruption in 200 responses). Verify first, then retry such a pair
      // once on a fresh workspace — a green pair is never re-rolled, only a
      // red suspicious one gets its second chance. The NUL fingerprint lives
      // in the disk transcript, which the store flushes lazily after the
      // session goes idle, hence the rescan delays.
      verify = await verifyWorkspace(task.dir, task, ws);
      const stall = result.timedOut && result.toolCalls <= 5;
      const instantFinish = !result.timedOut && result.toolCalls === 0;
      // A session the server ended with status error is never an honest
      // completion (job-catchup, 2026-10-04 sweep: exit 1 after 3 calls with
      // 9/10 firings already on disk). Same call ceiling as the stall wall;
      // verify-first keeps a green pair from being re-rolled.
      const sessionError =
        !result.timedOut && agent === "builtin" && result.exitCode === 1 && result.toolCalls <= 5;
      let corrupted = false;
      if (agent === "builtin" && !verify.ok && !stall && !instantFinish && !sessionError && !retried) {
        for (const delay of [0, 500, 1500]) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (await sessionTranscriptHasNul(slot.server, ws)) {
            corrupted = true;
            break;
          }
        }
      }
      if (!(stall || instantFinish || sessionError || corrupted) || retried || verify.ok) break;
      retried = true;
      retryReason = stall
        ? `timeout wall with ${result.toolCalls} calls`
        : instantFinish
          ? "finished with 0 tool calls"
          : sessionError
            ? `session errored with ${result.toolCalls} calls`
            : "NUL-corrupted tool arguments";
      console.warn(`artifact signature on ${label} (${retryReason}) — retrying once`);
    }
    const row = {
      agent,
      task: task.id,
      repeat: rep,
      ok: verify.ok,
      verifyOutput: verify.output.slice(0, 600),
      files: changedFiles(ws),
      ...(faults.length ? { faults } : {}),
      ...(prompts?.length > 1 ? { turns: prompts.length } : {}),
      ...(retried ? { retried, retryReason } : {}),
      ...result,
      crashed: result.exitCode !== 0 && result.exitCode !== null,
    };
    if (!opts.keep) {
      // The slot server may still hold the workspace as its cwd and Windows
      // answers EPERM. A failed cleanup must not kill the run: leave the
      // workspace behind (as --keep would) and move on.
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        console.warn(`cleanup failed, workspace left: ${ws}`);
      }
    }
    return row;
  };

  // All (agent, task, repeat) pairs; builtin+pi run on N parallel slots, omp
  // runs on a single chain (its profile file is global — one config at a time).
  const rows = [];
  let done = 0;
  const total = opts.agents.length * tasks.length * opts.repeats;
  const ompPairs = [];
  const freePairs = [];
  for (const agent of opts.agents) {
    for (const task of tasks) {
      for (let rep = 1; rep <= opts.repeats; rep++) {
        (agent === "omp" ? ompPairs : freePairs).push({ agent, task, rep });
      }
    }
  }
  const C = Math.min(opts.concurrency, Math.max(1, freePairs.length));
  const slots = Array.from({ length: C }, (_, idx) => ({ idx, server: null }));
  // One pair's accident degrades to a failed row; results are written at the
  // end, so a thrown pair must never take the whole run with it.
  const safeRunPair = async (pair, slot) => {
    try {
      return await runPair(pair, slot);
    } catch (err) {
      console.warn(`pair failed: ${pair.agent}/${pair.task.id}: ${String(err).split("\n")[0]}`);
      return {
        agent: pair.agent, task: pair.task.id, repeat: pair.rep, ok: false,
        verifyOutput: `pair failed: ${String(err).slice(0, 400)}`, files: [],
        toolCalls: 0, toolErrors: 0, toolNames: {}, tokensIn: 0, tokensOut: 0,
        tokensTotal: 0, tokensCached: 0, contextTokens: 0, cost: 0, finalText: "",
        stopReason: "", wallMs: 0, exitCode: null, timedOut: false, stderrTail: "",
        crashed: true,
      };
    }
  };
  const pairWorkers = slots.map((slot) =>
    (async () => {
      for (;;) {
        const pair = freePairs.shift();
        if (!pair) break;
        const row = await safeRunPair(pair, slot);
        rows.push(row);
        done += 1;
        logRow(row, done, total);
      }
    })(),
  );
  const ompWorker = (async () => {
    for (;;) {
      const pair = ompPairs.shift();
      if (!pair) break;
      const row = await safeRunPair(pair, slots[0]);
      rows.push(row);
      done += 1;
      logRow(row, done, total);
    }
  })();
  await Promise.all([...pairWorkers, ompWorker]);
  for (const slot of slots) slot.server?.stop();

  const file = path.join(opts.out, `${stamp}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const diagnostics = proxy ? proxy.summary() : [];
  writeLedgerAppendix(opts, stamp, rows, diagnostics);
  const summary = path.join(opts.out, `${stamp}.md`);
  writeFileSync(summary, renderSummary(rows, opts, diagnostics));
  console.log(`\n${file}\n${summary}`);
  if (proxy) {
    const callsFile = proxy.write();
    proxy.stop();
    console.log(`${callsFile}  (${proxy.calls.length} model calls)`);
  }

  console.log("\nagent      pass  runs  wall(s)  tools  tokIn   tokOut  cached  fails");
  for (const agent of opts.agents) {
    const rs = rows.filter((r) => r.agent === agent);
    if (!rs.length) continue;
    const sum = (pick) => rs.reduce((n, r) => n + (typeof pick(r) === "number" ? pick(r) : 0), 0);
    console.log(
      `${pad(agent, 11)}${String(rs.filter((r) => r.ok).length).padStart(3)}/${String(rs.length).padEnd(4)} ${String(Math.round(sum((r) => r.wallMs) / rs.length / 1000)).padStart(6)}  ${String(Math.round(sum((r) => r.toolCalls) / rs.length)).padStart(5)}  ${String(sum((r) => r.tokensIn)).padStart(7)} ${String(sum((r) => r.tokensOut)).padStart(7)} ${String(sum((r) => r.tokensCached)).padStart(7)}  ${String(rs.filter((r) => r.crashed).length).padStart(4)}`,
    );
  }

  if (diagnostics.length) {
    console.log("\nwire (seen by the proxy, not self-reported):");
    console.log("agent      calls  usage  sysChars  tools  schemaChars  prompt  cached  uncached  personality");
    for (const agent of opts.agents) {
      const ds = diagnostics.filter((d) => d.agent === agent);
      if (!ds.length) continue;
      const first = ds[0];
      const calls = ds.reduce((n, d) => n + d.calls, 0);
      const usage = ds.reduce((n, d) => n + d.usageCalls, 0);
      const prompt = ds.reduce((n, d) => n + (d.promptTokens ?? 0), 0);
      const cached = ds.reduce((n, d) => n + (d.cachedTokens ?? 0), 0);
      const traits = describeParams(first.params);
      console.log(
        `${pad(agent, 11)}${String(calls).padStart(5)}  ${String(usage).padStart(5)}  ${String(first.systemChars).padStart(8)}  ${String(first.tools).padStart(5)}  ${String(first.toolsChars).padStart(11)}  ${String(prompt).padStart(6)}  ${String(cached).padStart(6)}  ${String(prompt - cached).padStart(8)}  ${traits}`,
      );
    }
  }
}

/** One-line reading of the sampling parameters a harness sends. */
function describeParams(params = {}) {
  const traits = [];
  traits.push(params.include_usage ? "usage:on" : "usage:off");
  traits.push(params.stream ? "stream" : "nonstream");
  for (const key of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "tool_choice", "parallel_tool_calls", "reasoning_effort"]) {
    if (params[key] !== undefined) traits.push(`${key}=${JSON.stringify(params[key])}`);
  }
  return traits.join(" ");
}

/**
 * Append every run to the cross-stamp ledger (`all-runs.jsonl`): one line per
 * run, wire numbers when the proxy saw them and harness self-reports when it
 * did not. Per-stamp files are the raw record; this file is the statistic —
 * a single append-only log every future analysis reads first, so no run is
 * ever only discoverable by knowing its stamp.
 */
function writeLedgerAppendix(opts, stamp, rows, diagnostics) {
  let git = "";
  try {
    git = execSync("git rev-parse --short HEAD", { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  const byRun = new Map(diagnostics.map((d) => [`${d.agent}\u0000${d.task}\u0000${d.repeat}`, d]));
  const lines = rows.map((r) => {
    const d = byRun.get(`${r.agent}\u0000${r.task}\u0000${r.repeat}`);
    const promptTok = d?.promptTokens ?? r.tokensIn ?? null;
    const cachedTok = d?.cachedTokens ?? r.tokensCached ?? 0;
    return JSON.stringify({
      ts: new Date().toISOString(),
      stamp,
      git,
      model: opts.model,
      agent: r.agent,
      task: r.task,
      repeat: r.repeat,
      ok: r.ok,
      ...(r.faults?.length ? { faults: r.faults } : {}),
      ...(r.turns ? { turns: r.turns } : {}),
      wallMs: r.wallMs,
      tools: r.toolCalls,
      toolErrors: r.toolErrors ?? 0,
      modelCalls: d?.calls ?? null,
      promptTok,
      cachedTok,
      uncachedTok: promptTok == null ? null : promptTok - cachedTok,
      outTok: d?.completionTokens ?? r.tokensOut ?? null,
    });
  });
  appendFileSync(path.join(opts.out, "all-runs.jsonl"), lines.join("\n") + "\n");
}

function renderSummary(rows, opts, diagnostics = []) {
  // Proxy numbers are the wire truth; self-reported tokens fill in only where
  // the proxy saw nothing (crashed run, --no-proxy).
  const byRun = new Map(diagnostics.map((d) => [`${d.agent}\u0000${d.task}\u0000${d.repeat}`, d]));
  const lines = [
    `# Agent benchmark — ${new Date().toISOString()}`,
    "",
    `Model: \`${opts.model}\` on \`${opts.builtinUrl}\`${opts.proxy ? " (through the capturing proxy)" : " (direct)"}. ` +
      `Fresh workspace per run; verification is a hidden \`verify.mjs\` copied in after the agent stops.`,
    "",
    "tok in/cached/uncached come from the proxy when it ran (the wire), falling back to harness self-reports; " +
    "uncached is what the provider actually had to read.",
    "",
    "| task | agent | pass | wall s | tools | toolErr | tool kinds | tok in | tok cached | tok uncached | tok out | note |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const kinds = Object.entries(r.toolNames ?? {}).map(([k, v]) => `${k}×${v}`).join(" ") || "—";
    const notes = [
      r.retried ? "retried" : null,
      r.turns ? `${r.turns} turns` : null,
      r.timedOut ? "timeout" : r.crashed ? `exit ${r.exitCode}` : r.ok ? "" : "verify failed",
    ].filter(Boolean);
    const note = notes.join("; ");
    const d = byRun.get(`${r.agent}\u0000${r.task}\u0000${r.repeat}`);
    const tokIn = d?.promptTokens ?? r.tokensIn ?? null;
    const tokCached = d?.cachedTokens ?? r.tokensCached ?? 0;
    const tokOut = d?.completionTokens ?? r.tokensOut ?? null;
    const uncached = tokIn == null ? null : tokIn - tokCached;
    lines.push(
      `| ${r.task} | ${r.agent} | ${r.ok ? "✅" : "❌"} | ${(r.wallMs / 1000).toFixed(1)} | ${r.toolCalls} | ${r.toolErrors ?? 0} | ${kinds} | ${fmt(tokIn)} | ${fmt(tokCached)} | ${fmt(uncached)} | ${fmt(tokOut)} | ${note} |`,
    );
  }

  if (diagnostics.length) {
    // One row per agent+task: repeats merge so the table stays comparable.
    const merged = new Map();
    for (const d of diagnostics) {
      const key = `${d.agent}\u0000${d.task}`;
      const m = merged.get(key);
      if (!m) merged.set(key, { ...d });
      else {
        m.calls += d.calls;
        m.usageCalls += d.usageCalls;
        m.errors += d.errors;
        m.promptTokens = (m.promptTokens ?? 0) + (d.promptTokens ?? 0);
        m.completionTokens = (m.completionTokens ?? 0) + (d.completionTokens ?? 0);
        m.cachedTokens = (m.cachedTokens ?? 0) + (d.cachedTokens ?? 0);
      }
    }
    lines.push("", "## Wire diagnostics", "");
    lines.push(
      "_Seen by the proxy: what each harness actually sent and what the server actually returned._",
      "",
      "| agent | task | model calls | prompt tok (sum) | cached tok (sum) | uncached tok | prompt tok first | prompt tok last | system chars | tools | tool schema chars | params |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const d of merged.values()) {
      const uncached = d.promptTokens != null ? d.promptTokens - (d.cachedTokens ?? 0) : null;
      lines.push(
        `| ${d.agent} | ${d.task} | ${d.calls} | ${fmt(d.promptTokens)} | ${fmt(d.cachedTokens)} | ${fmt(uncached)} | ${d.promptTokensFirst ?? "—"} | ${d.promptTokensLast ?? "—"} | ${d.systemChars} | ${d.tools} | ${d.toolsChars} | \`${describeParams(d.params)}\` |`,
      );
    }
    const withUsage = diagnostics.reduce((n, d) => n + d.usageCalls, 0);
    const totalCalls = diagnostics.reduce((n, d) => n + d.calls, 0);
    if (!withUsage && totalCalls) {
      lines.push(
        "",
        `⚠️ The provider returned **no \`usage\`** on any of the ${totalCalls} calls, so per-call token numbers below are unavailable — ` +
          "clients that still show token counts computed them locally.",
      );
    }
    const errors = diagnostics.reduce((n, d) => n + d.errors, 0);
    if (errors) lines.push("", `⚠️ ${errors} model call(s) returned an HTTP error status.`);
  }

  lines.push("", "## Failure output", "");
  for (const r of rows.filter((x) => !x.ok)) {
    lines.push(`- **${r.task} / ${r.agent}**: ${r.verifyOutput.replace(/\n/g, " ").slice(0, 400)}`);
  }
  return lines.join("\n") + "\n";
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
