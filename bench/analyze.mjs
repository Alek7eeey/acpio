#!/usr/bin/env node
// Where a run's UNCACHED tokens actually go: per model call, the messages the
// request appended after the previous call's prefix — that tail is what the
// provider reads without a cache hit, so its composition is the optimization
// target. Reads `--proxy-dump` directories (NNN-<agent>-<model>.json, meta has
// the label). `--tool-calls` shows the appended messages of every call.
//
//   node bench/analyze.mjs bench/results/<stamp>.calls [--tool-calls]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node bench/analyze.mjs <results/<stamp>.calls dir> [--tool-calls]");
  process.exit(1);
}
const detail = process.argv.includes("--tool-calls");

const runs = new Map();
for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith(".json")) continue;
  const { meta, body } = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  const key = `${meta.label.agent}/${meta.label.task}`;
  if (!runs.has(key)) runs.set(key, []);
  runs.get(key).push({ n: meta.n, msgs: body.messages, tools: body.tools ?? [] });
}

const charsOf = (m) => JSON.stringify(m).length;
const describe = (m) => {
  if (m.role === "assistant") {
    const calls = (m.tool_calls ?? []).map((c) => c.function?.name).join("+");
    const textLen = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    const reasonLen = m.reasoning_content ? String(m.reasoning_content).length : 0;
    const callLen = (m.tool_calls ?? []).reduce((n, c) => n + JSON.stringify(c).length, 0);
    return `assistant(text=${textLen}${reasonLen ? ` reasoning=${reasonLen}` : ""}${callLen ? ` toolArgs=${callLen} [${calls}]` : ""})`;
  }
  if (m.role === "tool") {
    const name = String(m.tool_call_id ?? "").replace(/call_\d+_/, "") || "?";
    const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    return `tool(${len}ch)`;
  }
  return `${m.role}`;
};

for (const [key, calls] of [...runs.entries()].sort()) {
  const agent = key.split("/")[0];
  if (agent !== "builtin" && agent !== "pi") continue;
  calls.sort((a, b) => a.n - b.n);
  let prevCount = 0;
  const byKind = {};
  let tailTotal = 0;
  const lines = [];
  for (const c of calls) {
    const tail = c.msgs.slice(prevCount);
    prevCount = c.msgs.length;
    const size = tail.reduce((n, m) => n + charsOf(m), 0);
    tailTotal += size;
    for (const m of tail) {
      const d = describe(m);
      const kind = d.startsWith("assistant") ? "assistant" : d.slice(0, d.indexOf("("));
      byKind[kind] = (byKind[kind] ?? 0) + charsOf(m);
      lines.push(`    call#${c.n} +${charsOf(m)}ch  ${d}`);
    }
    if (tail.length) lines[lines.length - 1] += `   (call tail ${size}ch)`;
  }
  const schemaChars = JSON.stringify(calls[0].tools).length;
  console.log(`${key.padEnd(30)} calls=${calls.length} tail=${tailTotal}ch (~${Math.round(tailTotal / 4)}tok) schema=${schemaChars}ch`);
  console.log(
    "    by kind: " +
      Object.entries(byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}ch`)
        .join("  "),
  );
  if (detail) for (const l of lines) console.log(l);
}
