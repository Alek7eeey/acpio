/**
 * Context report for the built-in agent: replays every stored session through
 * the real compaction code and reports what the prompt view costs.
 *
 *   node scripts/context-report.mjs [--window 200000] [--threshold 80]
 *                                   [--tail 60] [--mask 3] [--top 10]
 *
 * Columns, per session:
 *   msgs/tok     stored messages and their estimated tokens
 *   wire one     sum of estimated prompt tokens over the session, one digest per
 *                pass (the behaviour before rolling compaction)
 *   wire roll    the same with a carried-over digest
 *   passes       compaction passes, one-shot → rolling
 *   sum tok      tokens handed to the summariser, one-shot → rolling
 *   masked       tokens the `read`/`grep` mask keeps off the wire
 *
 * The estimate is the agent's own chars/4 (`estimateTokens`), so the numbers
 * compare modes with each other rather than predicting a provider bill.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Built adapter, not the sources: the report must measure the shipped code.
// Run `npm run build -w @acpio/adapter-builtin` first.
const built = (file) => pathToFileURL(path.join(ROOT, "packages/adapter-builtin/dist", file)).href;
const { compactHistory, estimateTokens, maskToolResults } = await import(built("loop.js"));
const { OffloadStore, offloadToolResults } = await import(built("offload.js"));
// Archives land in a scratch folder: a report must not touch real sessions.
const SCRATCH = mkdtempSync(path.join(tmpdir(), "context-report-"));

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? Number(process.argv[at + 1]) : fallback;
}

// Defaults mirror the shipped settings (`builtinCompactionThresholdPercent`,
// `builtinKeepRecentPercent`, `builtinPruneToolResultsKeepLast`).
const WINDOW = arg("window", 200_000);
const THRESHOLD = arg("threshold", 80);
const TAIL = arg("tail", 20);
const MASK = arg("mask", 3);
const OFFLOAD = arg("offload", 4_000);
const TOP = arg("top", 10);
const DIR = path.join(ROOT, "data", "agent-sessions");

/** Turn boundaries: a user message starts the next turn. */
function turnEnds(messages) {
  const ends = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") ends.push(i + 1);
  }
  return ends.reverse();
}

/**
 * Replay one session turn by turn. `rolling` carries the digest across turns
 * (one summarisation per crossing, over the delta); otherwise every turn above
 * the line re-summarises the whole head, which is what the agent did before.
 */
async function replay(messages, rolling) {
  const cuts = turnEnds(messages);
  let wire = 0;
  let passes = 0;
  let summarizerTokens = 0;
  let state;
  for (const end of cuts) {
    const history = messages.slice(0, end);
    const view = maskToolResults(history, MASK);
    const result = await compactHistory({
      messages: view,
      contextWindow: WINDOW,
      thresholdPercent: THRESHOLD,
      keepRecentPercent: TAIL,
      ...(rolling ? { state } : {}),
      summarize: async (dropped) => {
        passes += 1;
        summarizerTokens += estimateTokens(dropped);
        return "S".repeat(600);
      },
      update: async (delta) => {
        passes += 1;
        summarizerTokens += estimateTokens(delta);
        return "S".repeat(600);
      },
    });
    state = result.state;
    wire += estimateTokens(result.messages);
  }
  return { wire, passes, summarizerTokens };
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const rows = [];
for (const file of files) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
  } catch {
    continue;
  }
  const messages = stored.messages ?? [];
  if (!messages.length) continue;
  const tokens = estimateTokens(messages);
  if (tokens < WINDOW * 0.1) continue;
  const one = await replay(messages, false);
  const roll = await replay(messages, true);
  const masked = tokens - estimateTokens(maskToolResults(messages, MASK));
  const archived =
    tokens -
    estimateTokens(
      offloadToolResults(messages, OffloadStore.forSession(SCRATCH, file.replace(/\.json$/, "")), OFFLOAD),
    );
  rows.push({ file, messages: messages.length, tokens, one, roll, masked, archived });
}

rows.sort((a, b) => b.tokens - a.tokens);
const show = rows.slice(0, TOP);
const pad = (v, n) => String(v).padStart(n);
console.log(
  `window ${WINDOW}  threshold ${THRESHOLD}%  tail ${TAIL}%  mask last ${MASK} messages\n`,
);
console.log(
  `${"session".padEnd(12)}${pad("msgs", 6)}${pad("tok", 9)}${pad("wire one", 11)}${pad("wire roll", 11)}${pad("passes", 10)}${pad("sum tok", 16)}${pad("masked", 9)}${pad("archived", 10)}`,
);
for (const row of show) {
  console.log(
    row.file.slice(0, 8).padEnd(12) +
      pad(row.messages, 6) +
      pad(row.tokens, 9) +
      pad(row.one.wire, 11) +
      pad(row.roll.wire, 11) +
      pad(`${row.one.passes}→${row.roll.passes}`, 10) +
      pad(`${row.one.summarizerTokens}→${row.roll.summarizerTokens}`, 16) +
      pad(row.masked, 9) +
      pad(row.archived, 10),
  );
}

const sum = (pick) => rows.reduce((n, row) => n + pick(row), 0);
const oneWire = sum((r) => r.one.wire);
const rollWire = sum((r) => r.roll.wire);
const oneSum = sum((r) => r.one.summarizerTokens);
const rollSum = sum((r) => r.roll.summarizerTokens);
const masked = sum((r) => r.masked);
const archived = sum((r) => r.archived);
const pct = (a, b) => (b ? `${Math.round(((a - b) / a) * 100)}%` : "—");
console.log(
  `\n${rows.length} sessions over the line` +
    `\n  prompt tokens on the wire: ${oneWire} → ${rollWire}  (${pct(oneWire, rollWire)} less)` +
    `\n  tokens handed to the summariser: ${oneSum} → ${rollSum}  (${pct(oneSum, rollSum)} less)` +
    `\n  passes: ${sum((r) => r.one.passes)} → ${sum((r) => r.roll.passes)}` +
    `\n  read/grep masked out of the newest view: ${masked} tokens across the ${rows.length} sessions` +
    `\n  bulky results archived as files the read tool can open: ${archived} tokens (offload over ${OFFLOAD})`,
);