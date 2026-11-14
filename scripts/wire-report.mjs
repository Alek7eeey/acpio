#!/usr/bin/env node
/**
 * What the wire log says about the bill.
 *
 * Reads `data/wire-log/*.jsonl` (see `packages/adapter-builtin/src/wireLog.ts`)
 * and answers two questions per chat: how much the provider charged, and how
 * much of every prompt it had to read instead of serving from its cache — with
 * the reason named per request: a changed system prompt, a changed tool list, a
 * changed key, or a rewritten message prefix.
 *
 *   node scripts/wire-report.mjs [--dir data/wire-log] [--session <id8>] [--top 20]
 *   node scripts/wire-report.mjs --diff <id8>
 *
 * `--diff` answers the question the summary cannot: the log says the prefix
 * moved, this says *which message* moved and by what bytes. It needs the bodies
 * — the word `full` in the log folder's `on` file (or `ACPIO_WIRE_LOG=full`).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const dir = path.resolve(arg("dir", "data/wire-log"));
const only = arg("session", "");
const top = Number(arg("top", "10"));
const diffOf = arg("diff", "");

/** The provider's own price list, per million tokens, from the relay's bills. */
const PRICE = { input: 0.294, output: 2.62 };

if (!fs.existsSync(dir)) {
  console.log(`no wire log in ${dir} — start the server with ACPIO_WIRE_LOG=1 (or create ${path.join(dir, "on")})`);
  process.exit(0);
}

const parseLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** The `seq.req.json` a request line names, or null when no body was recorded. */
function readBody(request) {
  if (!request?.bodyFile) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, request.bodyFile), "utf8"));
  } catch {
    return null;
  }
}

/** The tool behind a message, so a changed result reads as `read`/`bash`, not `tool`. */
function toolName(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const part = parts.find((p) => p?.type === "tool-call") ?? parts.find((p) => p?.type === "tool-result");
  return part?.toolName ?? "";
}

/** The JSON key the two versions part inside — `content`, `reasoning_content`, … */
function fieldAt(text, at) {
  const before = text.slice(0, Math.max(0, at)).match(/"([a-zA-Z_]+)":/g);
  return before ? before[before.length - 1].replace(/[":]/g, "") : "?";
}

const window = (text, at, width = 110) =>
  text.slice(Math.max(0, at - width), at + width).replace(/\s+/g, " ");

/**
 * Every pair of neighbouring requests of one chat whose bodies were recorded:
 * the first message that differs, the key it differs in, and the bytes on each
 * side of the parting. That is the difference between "the prefix moved" and
 * "the prefix moved because this message became a citation" — the second one
 * is load-bearing when deciding what to change.
 */
function diffChat(session) {
  const file = path.join(dir, `${session.slice(0, 8)}.jsonl`);
  if (!fs.existsSync(file)) {
    console.log(`нет файла ${file}`);
    return;
  }
  const requests = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseLine)
    .filter((line) => line?.kind === "request")
    .sort((a, b) => a.seq - b.seq);

  const pairs = [];
  let noBody = 0;
  let prev = null;
  for (const request of requests) {
    const body = readBody(request);
    if (body && prev) {
      const a = Array.isArray(prev.body.messages) ? prev.body.messages : [];
      const b = Array.isArray(body.messages) ? body.messages : [];
      const limit = Math.min(a.length, b.length);
      let index = -1;
      for (let i = 0; i < limit; i += 1) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        const left = JSON.stringify(a[index]);
        const right = JSON.stringify(b[index]);
        let at = 0;
        while (at < left.length && at < right.length && left[at] === right[at]) at += 1;
        pairs.push({
          seq: request.seq,
          index,
          of: b.length,
          role: b[index]?.role ?? "?",
          tool: toolName(b[index]),
          field: fieldAt(right, at) || fieldAt(left, at),
          was: window(left, at),
          now: window(right, at),
          sizes: [left.length, right.length],
        });
      }
    }
    if (!body) noBody += 1;
    if (body) prev = { body, seq: request.seq };
  }

  console.log(`\n### ${session.slice(0, 8)} — разбор тел запросов`);
  console.log(`  запросов ${requests.length} · с телом ${requests.length - noBody} · расхождений ${pairs.length}`);
  if (!requests.some((request) => request.bodyFile)) {
    console.log("  тел нет: лог писался в summary. Положи `full` в data/wire-log/on (или ACPIO_WIRE_LOG=full) и перезапусти сервер.");
    return;
  }

  for (const pair of pairs.slice(0, 5)) {
    console.log(
      `\n  #${pair.seq}  message[${pair.index}] из ${pair.of} · ${pair.role}${pair.tool ? `/${pair.tool}` : ""} · поле ${pair.field} · ${pair.sizes[0]}→${pair.sizes[1]} символов`,
    );
    console.log(`    было: …${pair.was}…`);
    console.log(`    стало: …${pair.now}…`);
  }

  const groups = new Map();
  for (const pair of pairs) {
    const key = `${pair.role}${pair.tool ? `/${pair.tool}` : ""} · ${pair.field}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if (groups.size) {
    console.log("\n  по видам:");
    for (const [key, count] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`    ${count}× ${key}`);
  }
}

if (diffOf) {
  diffChat(diffOf);
  process.exit(0);
}

const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".jsonl"))
  .filter((name) => !only || name.startsWith(only));

const chats = [];
for (const file of files) {
  const lines = fs
    .readFileSync(path.join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const requests = lines.filter((line) => line.kind === "request");
  const responses = new Map(lines.filter((line) => line.kind === "response").map((line) => [line.seq, line]));
  if (!requests.length) continue;

  let input = 0;
  let cached = 0;
  let output = 0;
  let cold = 0; // requests the provider read in full
  const reasons = { systemChanged: 0, toolsChanged: 0, keyChanged: 0, prefixRewritten: 0 };
  const worst = [];
  for (const request of requests) {
    const answer = responses.get(request.seq);
    const usage = answer?.usage ?? null;
    const tokens = usage ? usage.input : 0;
    if (usage) {
      input += usage.input;
      cached += usage.cached;
      output += usage.output;
    }
    const fresh = usage ? Math.max(0, usage.input - usage.cached) : 0;
    if (usage && usage.input > 0 && usage.cached === 0) cold += 1;
    if (request.prefixSame !== null) {
      if (request.systemChanged) reasons.systemChanged += 1;
      else if (request.toolsChanged) reasons.toolsChanged += 1;
      if (request.keyChanged) reasons.keyChanged += 1;
      // Growth alone keeps the whole previous chain as a prefix; any shorter
      // match means an earlier message changed — an offload, a mask, a summary —
      // and the provider re-reads the prompt from the first difference on.
      if (request.prevMessages > 0 && request.prefixSame < request.prevMessages) {
        reasons.prefixRewritten += 1;
      }
      worst.push({ seq: request.seq, same: request.prefixSame, prev: request.prevMessages, fresh, tokens });
    }
  }
  worst.sort((a, b) => b.fresh - a.fresh);
  chats.push({
    file,
    sessionId: requests[0].sessionId,
    model: requests[0].model,
    requests: requests.length,
    input,
    cached,
    output,
    cold,
    reasons,
    worst,
    cost: (Math.max(0, input - cached) * PRICE.input + output * PRICE.output) / 1e6,
  });
}

chats.sort((a, b) => b.cost - a.cost);
let total = 0;
for (const chat of chats) {
  total += chat.cost;
  const share = chat.input ? Math.round((chat.cached / chat.input) * 100) : 0;
  console.log(
    `\n### ${chat.sessionId.slice(0, 8)} ${chat.model} — $${chat.cost.toFixed(2)}`,
    `\n  запросов ${chat.requests} · вход ${(chat.input / 1e6).toFixed(1)}M · кэш ${share}% · выход ${(chat.output / 1e3).toFixed(0)}K · холодных ${chat.cold}`,
    `\n  причины промахов: system ${chat.reasons.systemChanged} · tools ${chat.reasons.toolsChanged} · key ${chat.reasons.keyChanged} · переписанный префикс ${chat.reasons.prefixRewritten}`,
  );
  for (const row of chat.worst.slice(0, top)) {
    console.log(
      `    #${String(row.seq).padStart(4)} совпало ${String(row.same).padStart(4)}/${String(row.prev).padEnd(4)} вчистую ${String(row.fresh).padStart(7)} из ${String(row.tokens).padStart(7)}`,
    );
  }
}
console.log(`\nвсего по логу: $${total.toFixed(2)} · чатов ${chats.length} · файлов ${files.length}`);
