#!/usr/bin/env node
// Benchmark runner: same task fixture, same model, one fresh workspace per run.
//
//   node bench/run.mjs --agents pi,omp,builtin --tasks fix-sum,fizzbuzz
//   node bench/run.mjs --agents builtin --repeats 3 --keep
//
// Results land as one row per run in bench/results/<stamp>.jsonl.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchServer, runBuiltinAgent } from "./lib/builtin-agent.mjs";
import { ensureOmpModel, ompProfile, runCliAgent } from "./lib/cli-agent.mjs";
import { changedFiles, makeWorkspace, verifyWorkspace } from "./lib/util.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ROOT = path.join(REPO, "bench", "tasks");

function parseArgs(argv) {
  const out = {
    agents: ["pi", "omp", "builtin"],
    tasks: null,
    repeats: 1,
    model: "im/im-llm",
    builtinUrl: process.env.BENCH_BASE_URL || "http://api.ai.dev.imdomain/v1",
    builtinKey: process.env.BENCH_API_KEY || "no",
    contextWindow: Number(process.env.BENCH_CONTEXT_WINDOW || 64000),
    timeoutMs: 300_000,
    keep: false,
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
      case "--repeats": out.repeats = Math.max(1, Number(take())); break;
      case "--model": out.model = take(); break;
      case "--builtin-url": out.builtinUrl = take(); break;
      case "--builtin-key": out.builtinKey = take(); break;
      case "--context-window": out.contextWindow = Number(take()); break;
      case "--timeout": out.timeoutMs = Number(take()); break;
      case "--out": out.out = path.resolve(take()); break;
      case "--keep": out.keep = true; break;
      case "--help": out.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return out;
}

function loadTasks(only) {
  const entries = readdirSync(TASK_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  const tasks = entries.map((e) => ({
    dir: path.join(TASK_ROOT, e.name),
    ...JSON.parse(readFileSync(path.join(TASK_ROOT, e.name, "task.json"), "utf8")),
  }));
  return (only ? tasks.filter((t) => only.includes(t.id)) : tasks).sort((a, b) => a.id.localeCompare(b.id));
}

const fmt = (n, digits = 0) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-");
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "Agent benchmark — same task, same model, fresh workspace per run.",
        "",
        "  node bench/run.mjs [--agents pi,omp,builtin] [--tasks fix-sum,fizzbuzz]",
        "                     [--repeats N] [--model <provider>/<id>] [--timeout ms]",
        "                     [--builtin-url <url>] [--builtin-key <key>]",
        "                     [--context-window N] [--out <dir>] [--keep]",
        "",
        "Results: bench/results/<stamp>.jsonl and <stamp>.md",
      ].join("\n"),
    );
    return;
  }

  const tasks = loadTasks(opts.tasks);
  if (!tasks.length) throw new Error("no tasks selected");

  const slash = opts.model.indexOf("/");
  if (slash < 1) throw new Error(`--model must be <provider>/<id>, got "${opts.model}"`);
  const provider = opts.model.slice(0, slash);
  const modelId = opts.model.slice(slash + 1);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workRoot = path.join(REPO, "bench", ".work", stamp);
  mkdirSync(workRoot, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  console.log(`model: ${provider}/${modelId}   agents: ${opts.agents.join(", ")}   tasks: ${tasks.map((t) => t.id).join(", ")}   repeats: ${opts.repeats}\n`);

  if (opts.agents.includes("omp")) {
    const file = ensureOmpModel(ompProfile(), {
      provider,
      baseUrl: opts.builtinUrl,
      apiKey: opts.builtinKey,
      modelId,
      contextWindow: opts.contextWindow,
    });
    console.log(`omp provider profile: ${file}`);
  }

  let server = null;
  if (opts.agents.includes("builtin")) {
    server = new BenchServer({
      repo: REPO,
      stateDir: workRoot,
      provider: {
        provider,
        baseUrl: opts.builtinUrl,
        apiKey: opts.builtinKey,
        modelId,
        contextWindow: opts.contextWindow,
      },
    });
    await server.start();
    console.log(`builtin server up on ${server.base}\n`);
  }

  const rows = [];
  try {
    for (const agent of opts.agents) {
      for (const task of tasks) {
        for (let rep = 1; rep <= opts.repeats; rep++) {
          const label = `${agent}-${task.id}-r${rep}`;
          const ws = makeWorkspace(task.dir, workRoot, label);
          const timeoutMs = task.timeoutMs ?? opts.timeoutMs;
          let result;
          try {
            result =
              agent === "builtin"
                ? await runBuiltinAgent(server, { task, ws, timeoutMs })
                : await runCliAgent(agent, { task, ws, provider, modelId, timeoutMs });
          } catch (err) {
            result = {
              toolCalls: 0, toolErrors: 0, toolNames: {}, tokensIn: 0, tokensOut: 0,
              tokensTotal: 0, contextTokens: 0, cost: 0, finalText: "", stopReason: "",
              wallMs: 0, exitCode: null, timedOut: false, stderrTail: String(err),
            };
          }
          const verify = await verifyWorkspace(task.dir, task, ws);
          const row = {
            agent,
            task: task.id,
            repeat: rep,
            ok: verify.ok,
            verifyOutput: verify.output.slice(0, 600),
            files: changedFiles(ws),
            ...result,
            crashed: result.exitCode !== 0 && result.exitCode !== null,
          };
          rows.push(row);
          console.log(
            `${verify.ok ? "PASS" : "FAIL"}  ${pad(label, 26)} ${String(Math.round(row.wallMs / 1000)).padStart(4)}s  tools=${String(row.toolCalls).padStart(2)}  in=${String(row.tokensIn).padStart(6)}  out=${String(row.tokensOut).padStart(5)}  ${row.timedOut ? "TIMEOUT" : ""}${row.crashed ? `exit=${row.exitCode}` : ""}`,
          );
          if (!verify.ok) console.log(`      ↳ ${verify.output.split("\n").slice(0, 4).join(" | ").slice(0, 300)}`);
          if (!opts.keep) rmSync(ws, { recursive: true, force: true });
        }
      }
    }
  } finally {
    server?.stop();
  }

  const file = path.join(opts.out, `${stamp}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const summary = path.join(opts.out, `${stamp}.md`);
  writeFileSync(summary, renderSummary(rows, opts));
  console.log(`\n${file}\n${summary}`);

  console.log("\nagent      pass  runs  wall(s)  tools  tokIn   tokOut  fails");
  for (const agent of opts.agents) {
    const rs = rows.filter((r) => r.agent === agent);
    if (!rs.length) continue;
    const sum = (pick) => rs.reduce((n, r) => n + (typeof pick(r) === "number" ? pick(r) : 0), 0);
    console.log(
      `${pad(agent, 11)}${String(rs.filter((r) => r.ok).length).padStart(3)}/${String(rs.length).padEnd(4)} ${String(Math.round(sum((r) => r.wallMs) / rs.length / 1000)).padStart(6)}  ${String(Math.round(sum((r) => r.toolCalls) / rs.length)).padStart(5)}  ${String(sum((r) => r.tokensIn)).padStart(7)} ${String(sum((r) => r.tokensOut)).padStart(7)}  ${String(rs.filter((r) => r.crashed).length).padStart(4)}`,
    );
  }
}

function renderSummary(rows, opts) {
  const lines = [
    `# Agent benchmark — ${new Date().toISOString()}`,
    "",
    `Model: \`${opts.model}\` on \`${opts.builtinUrl}\`. Fresh workspace per run; ` +
      `verification is a hidden \`verify.mjs\` copied in after the agent stops.`,
    "",
    "| task | agent | pass | wall s | tools | tool kinds | tok in | tok out | note |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const kinds = Object.entries(r.toolNames ?? {}).map(([k, v]) => `${k}×${v}`).join(" ") || "—";
    const note = r.timedOut ? "timeout" : r.crashed ? `exit ${r.exitCode}` : r.ok ? "" : "verify failed";
    lines.push(
      `| ${r.task} | ${r.agent} | ${r.ok ? "✅" : "❌"} | ${(r.wallMs / 1000).toFixed(1)} | ${r.toolCalls} | ${kinds} | ${r.tokensIn} | ${r.tokensOut} | ${note} |`,
    );
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
