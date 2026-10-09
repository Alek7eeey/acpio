/**
 * Wire-level check for the context chip's token panel: is what the panel shows
 * what the provider actually said?
 *
 *   node scripts/usage-probe.mjs up [--provider <id|name|index>] [--duration <sec>] [--db <file>]
 *   node scripts/usage-probe.mjs report [--calls <file>] [--session <id|title>] [--db <file>]
 *
 * `up` puts bench/lib/proxy.mjs in front of the built-in agent's provider and
 * prints the base URL to paste into Settings → built-in provider. The proxy
 * parses `usage` out of the provider's own responses — no AI SDK, no harness,
 * no chat code — so its per-call in/out/cached is the ground truth.
 *
 * Recipe: paste the printed URL → send ONE long turn in the probe chat →
 * Ctrl+C here. While the proxy is up every chat on that provider routes
 * through it, and their calls join the wire sum on purpose, so keep the app
 * otherwise idle: the panel keeps only the LAST usage report of a session.
 *
 * `report` compares that wire sum against `sessions.usage` — the exact row the
 * panel reads. Equal numbers = the panel is quoting the provider verbatim.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = path.join(ROOT, "bench", "results");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { LlmProxy } = await import(pathToFileURL(path.join(ROOT, "bench/lib/proxy.mjs")).href);

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--")
    ? process.argv[at + 1]
    : null;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (n) => Number(n).toLocaleString("en-US");

function openDb() {
  const file = arg("db") ? path.resolve(arg("db")) : path.join(ROOT, "data", "acpio.db");
  if (!existsSync(file)) fail(`no database at ${file} (point at it with --db)`);
  return new Database(file, { readonly: true });
}

function readSettings(db) {
  const row = db.prepare("select value from settings where key = 'app'").get();
  if (!row) fail("settings row `app` not found in the database");
  const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
  const list = (value.builtinProviders ?? []).filter((p) => p.url);
  if (!list.length) fail("no built-in provider with a URL in settings");
  return list;
}

function pickProvider(list) {
  const want = arg("provider");
  if (want == null) {
    const enabled = list.filter((p) => p.enabled !== false);
    return enabled[0] ?? list[0];
  }
  const index = Number(want);
  const byIndex = Number.isInteger(index) && index >= 1 && index <= list.length ? list[index - 1] : null;
  const byName = list.find(
    (p) => p.id === want || String(p.name ?? "").toLowerCase() === want.toLowerCase(),
  );
  const hit = byIndex ?? byName;
  if (!hit) {
    list.forEach((p, i) => console.error(`  ${i + 1}. ${p.id} — ${p.name ?? ""} <${p.url}>`));
    fail(`no provider matches --provider ${want} (see the list above)`);
  }
  return hit;
}

/** Every captured call, in wire order. */
function loadCalls(file) {
  if (!file || !existsSync(file)) fail(`no capture at ${file ?? "(pass --calls <file>)"}`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function newestCapture() {
  if (!existsSync(RESULTS)) return null;
  const files = readdirSync(RESULTS)
    .filter((name) => name.startsWith("usage-probe-") && name.endsWith(".calls.jsonl"))
    .sort();
  return files.length ? path.join(RESULTS, files.at(-1)) : null;
}

/** What the provider said, summed over the calls the proxy saw. */
function wireStats(calls) {
  const usable = calls.filter(
    (c) => c.method === "POST" && c.status < 400 && c.response?.usage,
  );
  let prompt = 0;
  let cached = 0;
  let completion = 0;
  let noDetails = 0;
  for (const call of usable) {
    const u = call.response.usage;
    prompt += num(u.prompt);
    completion += num(u.completion);
    if (num(u.cached) > 0) cached += num(u.cached);
    else noDetails += 1;
  }
  const last = usable.at(-1);
  return {
    calls: usable.length,
    noDetails,
    prompt,
    cached,
    fresh: prompt - cached,
    completion,
    lastPrompt: last ? num(last.response.usage.prompt) : null,
    lastCompletion: last ? num(last.response.usage.completion) : null,
  };
}

/** The row the panel reads: `sessions.usage`. */
function panelStats(db, want) {
  const rows = db
    .prepare("select id, title, usage, updated_at from sessions where usage is not null order by updated_at desc")
    .all();
  if (!rows.length) fail("no session with a usage report in the database");
  let hit = null;
  if (want) {
    hit =
      rows.find((r) => r.id === want || r.id.startsWith(want)) ??
      rows.filter((r) => String(r.title).toLowerCase().includes(want.toLowerCase()))[0];
    if (!hit) {
      rows.slice(0, 10).forEach((r) => console.error(`  ${r.id}  ${String(r.title).slice(0, 70)}`));
      fail(`no chat matches --session ${want} (see the list above)`);
    }
  } else {
    hit = rows[0];
  }
  const raw = typeof hit.usage === "string" ? JSON.parse(hit.usage) : hit.usage;
  return {
    id: hit.id,
    title: hit.title,
    input: raw.inputTokens ?? null,
    cached: raw.cachedInputTokens ?? null,
    output: raw.outputTokens ?? null,
    used: raw.usedTokens ?? null,
    window: raw.contextWindow ?? null,
  };
}

function printTable(calls) {
  const usable = calls.filter((c) => c.method === "POST" && c.status < 400 && c.response?.usage);
  if (!usable.length) return;
  console.log("\nper call (wire order):");
  const shown = usable.slice(0, 40);
  for (const c of shown) {
    const u = c.response.usage;
    const fresh = num(u.prompt) - num(u.cached);
    console.log(
      `  #${String(c.n).padStart(3)} in=${String(num(u.prompt)).padStart(8)} ` +
        `cached=${String(num(u.cached)).padStart(8)} fresh=${String(fresh).padStart(7)} ` +
        `out=${String(num(u.completion)).padStart(6)} msgs=${c.request?.messages ?? "?"}`,
    );
  }
  if (usable.length > shown.length) console.log(`  … ${usable.length - shown.length} more`);
}

function compare(wire, panel) {
  const delta = (a, b) => (a == null || b == null ? null : a - b);
  const lines = [
    `wire (provider's own usage, ${wire.calls} calls)   in=${fmt(wire.prompt)}  cached=${fmt(wire.cached)}  fresh=${fmt(wire.fresh)}  out=${fmt(wire.completion)}`,
    `panel (sessions.usage of "${String(panel.title).slice(0, 40)}")  in=${fmt(panel.input ?? 0)}  cached=${fmt(panel.cached ?? 0)}  fresh=${fmt(panel.input != null && panel.cached != null ? panel.input - panel.cached : 0)}  out=${fmt(panel.output ?? 0)}`,
    `delta (wire − panel)                       in=${fmt(delta(wire.prompt, panel.input) ?? 0)}  cached=${fmt(delta(wire.cached, panel.cached) ?? 0)}  out=${fmt(delta(wire.completion, panel.output) ?? 0)}`,
  ];
  console.log("\n" + lines.join("\n"));

  if (wire.lastPrompt != null && panel.used != null) {
    const call = wire.lastPrompt + wire.lastCompletion;
    console.log(
      `last call on the wire: prompt+completion=${fmt(call)} vs panel "current size"=${fmt(panel.used)}` +
        (call === panel.used ? "  ✓" : `  (${call - panel.used})`),
    );
  }

  const same =
    panel.input != null &&
    panel.cached != null &&
    panel.output != null &&
    wire.prompt === panel.input &&
    wire.cached === panel.cached &&
    wire.completion === panel.output;
  if (same) {
    console.log("\nMATCH: the panel quotes the provider verbatim.");
    return;
  }
  console.log("\nMISMATCH — likely causes, in order:");
  if (wire.prompt > (panel.input ?? 0)) {
    console.log("  - more than one turn (or another chat) crossed the proxy: the panel keeps only the last usage report of a session;");
  }
  if (wire.prompt < (panel.input ?? 0)) {
    console.log("  - the proxy was started mid-turn, or the turn continued after it stopped: wire capture is partial;");
  }
  console.log("  - the session's last report is a step-level update, not the turn-end sum (check again once the turn is idle);");
  if (wire.noDetails > 0) {
    console.log(`  - ${wire.noDetails} call(s) returned no prompt_tokens_details: "cached" for them is 0, so "fresh" is inflated.`);
  }
}

async function up() {
  const db = openDb();
  const list = readSettings(db);
  const provider = pickProvider(list);
  db.close();

  console.log("built-in providers:");
  list.forEach((p, i) =>
    console.log(
      `  ${i + 1}. ${p.id === provider.id ? "*" : " "} ${p.name ?? p.id}  ${p.url}` +
        (p.enabled === false ? "  (disabled)" : ""),
    ),
  );

  const stamp = `usage-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const proxy = new LlmProxy({
    upstream: provider.url,
    outDir: RESULTS,
    stamp,
    verbose: true,
  });
  proxy.setLabel({ agent: "probe", task: "live", repeat: 0 });
  const base = await proxy.start();

  console.log(`
probe provider : ${provider.name ?? provider.id} (${provider.id})
upstream       : ${provider.url}
capture        : ${path.join(RESULTS, stamp + ".calls.jsonl")}

1. In the app: Settings → built-in provider "${provider.name ?? provider.id}" →
   URL: ${base}          (put "${provider.url}" back afterwards)
2. Send ONE long turn in the chat you want to check — a turn with several
   tool calls. Keep the app otherwise idle while the proxy is up.
3. Ctrl+C here: the wire sum is printed and compared with the panel's row.
   Or leave it running and, in a second terminal:
       node scripts/usage-probe.mjs report --session <chat id>
   (every call lands in the capture file as it finishes)
`);

  // A second terminal can read the capture while this one holds the proxy:
  // every call is appended to the file as it finishes.
  const duration = Number(arg("duration") ?? 0);
  if (duration > 0) setTimeout(() => finish("duration"), duration * 1000);

  let done = false;
  function finish(why) {
    if (done) return;
    done = true;
    try {
      proxy.stop();
    } catch {}
    let file = null;
    try {
      file = proxy.write();
    } catch (err) {
      console.error(`capture not written: ${err.message}`);
      process.exit(1);
    }
    console.log(`\nstopped (${why}). capture: ${file}`);
    const wire = wireStats(loadCalls(file));
    if (!wire.calls) {
      console.log("no model calls captured — paste the URL above into Settings and send a turn first.");
      process.exit(0);
    }
    try {
      printTable(loadCalls(file));
      const panel = panelStats(openDb(), arg("session"));
      compare(wire, panel);
      console.log(
        `\nRemember to put the provider URL back to: ${provider.url}\n` +
          `Re-run later with: node scripts/usage-probe.mjs report --session ${panel.id}`,
      );
    } catch (err) {
      console.error(`report failed: ${err.message}`);
    }
    process.exit(0);
  }
  process.on("SIGINT", () => finish("Ctrl+C"));
  process.on("SIGTERM", () => finish("SIGTERM"));
}

function report() {
  const file = arg("calls") ?? newestCapture();
  if (!file) fail(`no capture in ${RESULTS} — run \`node scripts/usage-probe.mjs up\` first`);
  const calls = loadCalls(file);
  const wire = wireStats(calls);
  console.log(`capture: ${file}`);
  if (!wire.calls) fail("the capture holds no successful model calls");
  printTable(calls);
  const panel = panelStats(openDb(), arg("session"));
  compare(wire, panel);
}

const cmd = process.argv[2];
if (cmd === "up") await up();
else if (cmd === "report") report();
else
  fail(`usage:
  node scripts/usage-probe.mjs up [--provider <id|name|index>] [--duration <sec>] [--db <file>]
  node scripts/usage-probe.mjs report [--calls <file>] [--session <id|title part>] [--db <file>]`);
