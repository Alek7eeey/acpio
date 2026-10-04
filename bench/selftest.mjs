#!/usr/bin/env node
// Corpus self-test: every task must (a) FAIL verification on its pristine
// fixture — otherwise the hidden verifier does not discriminate; (b) PASS on
// every solution*/ dir; (c) with each declared fault applied, still FAIL on
// the fixture and still PASS on the solution — a fault must obstruct the
// agent, never the graded path. Mirrors the generator-validator rule
// ("fails on the bug, passes on the fix") for hand-written tasks.
//
//   node bench/selftest.mjs                    # every task, every root
//   node bench/selftest.mjs --only long-ci-green
//   node bench/selftest.mjs --strict           # pristine-fail becomes required
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "./lib/util.mjs";
import { applyFaults } from "./lib/faults.mjs";

const BENCH = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(BENCH, "..");

const argv = process.argv.slice(2);
let strict = false;
let only = null;
const roots = [path.join(BENCH, "tasks"), path.join(BENCH, "private", "tasks")];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--only") only = argv[++i].split(",").map((s) => s.trim());
  else if (argv[i] === "--strict") strict = true;
  else if (argv[i] === "--tasks-root") roots.push(path.resolve(argv[++i]));
  else throw new Error(`unknown flag: ${argv[i]}`);
}

const workRoot = path.join(REPO, "tmp", "selftest");
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(workRoot, { recursive: true });
let wsN = 0;

/** Empty starting workspace for from-scratch tasks (no fixture/). */
const emptyWorkspace = () => {
  const ws = path.join(workRoot, `empty${wsN++}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};

async function runVerify(baseDir, taskDir, faults) {
  const ws = path.join(workRoot, `ws${wsN++}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  cpSync(baseDir, ws, { recursive: true });
  await applyFaults(taskDir, ws, faults ?? []);
  cpSync(path.join(taskDir, "verify.mjs"), path.join(ws, "verify.mjs"));
  const res = await runProcess(process.execPath, ["verify.mjs"], { cwd: ws, timeoutMs: 60_000 });
  const output = (res.stdout + res.stderr).trim().split("\n").filter(Boolean).pop() ?? "";
  rmSync(ws, { recursive: true, force: true });
  return { passed: res.code === 0, output: output.slice(0, 120) };
}

const problems = [];
const rows = [];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const e of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskDir = path.join(root, e.name);
    if (!existsSync(path.join(taskDir, "verify.mjs"))) continue;
    if (only && !only.includes(e.name)) continue;
    const task = JSON.parse(await (await import("node:fs")).promises.readFile(path.join(taskDir, "task.json"), "utf8"));
    const fixture = path.join(taskDir, "fixture");
    const fromScratch = !existsSync(fixture);
    const row = { id: task.id, pristine: null, golds: [], faults: [] };

    // From-scratch tasks (no fixture/) self-test against an empty workspace.
    const pristineBase = fromScratch ? emptyWorkspace() : fixture;
    const pristine = await runVerify(pristineBase, taskDir);
    row.pristine = pristine.passed ? "PASSED?!" : "fails";
    if (pristine.passed) problems.push(`${task.id}: verifier PASSES on the pristine fixture — it does not discriminate`);

    const solutions = readdirSync(taskDir).filter((d) => d.startsWith("solution"));
    if (!solutions.length) {
      row.golds.push("none");
    }
    for (const sol of solutions) {
      const r = await runVerify(path.join(taskDir, sol), taskDir);
      row.golds.push(`${sol}: ${r.passed ? "ok" : `FAILED (${r.output})`}`);
      if (!r.passed) problems.push(`${task.id}: verifier FAILS on ${sol}/ — ${r.output}`);
      for (const fault of task.faults ?? []) {
        const rf = await runVerify(path.join(taskDir, sol), taskDir, [fault]);
        row.faults.push(`${sol}+${fault}: ${rf.passed ? "ok" : `FAILED (${rf.output})`}`);
        if (!rf.passed) problems.push(`${task.id}: fault ${fault} breaks the graded path — ${sol} no longer passes`);
      }
    }
    for (const fault of task.faults ?? []) {
      const rf = await runVerify(fixture, taskDir, [fault]);
      row.faults.push(`fixture+${fault}: ${rf.passed ? "PASSED?!" : "fails"}`);
      if (rf.passed) problems.push(`${task.id}: fault ${fault} makes the fixture pass — the fault masks the task`);
    }
    rows.push(row);
  }
}

for (const row of rows) {
  const golds = row.golds.join("  ");
  const faults = row.faults.length ? "  " + row.faults.join("  ") : "";
  console.log(`${row.id.padEnd(28)} pristine: ${row.pristine.padEnd(9)} ${golds}${faults}`);
}
console.log(`\n${rows.length} task(s) checked`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("all green");
