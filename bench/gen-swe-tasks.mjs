// One-shot generator for the swe-* task family: mini packages with a planted
// regression, an issue-style or check-style prompt, and a hidden verifier.
// For every task the FIXED sources are the source of truth; the fixture gets
// the bug applied over them, so the validator can fail-before/pass-after.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import easyTasks from "./swe-tasks/easy.mjs";
import mediumTasks from "./swe-tasks/medium.mjs";
import hardTasks from "./swe-tasks/hard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS = path.join(ROOT, "bench", "tasks");

const T = (id, title, prompt, files, buggy, verify, timeoutMs = 240_000) => ({
  id, title, prompt, files, buggy, verify, timeoutMs,
});

/** Deterministic ~170KB log: 1500 bracket lines + 900 key=value lines + garbage. */
function buildServiceLog() {
  const lines = [];
  const bracketServices = ["payments", "auth", "search", "media", "billing"];
  const bracketLevels = ["info", "warn", "error", "debug"];
  for (let i = 0; i < 1500; i++) {
    const ts = `2026-09-30T09:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    lines.push(`${ts} [${bracketLevels[i % 4]}] ${bracketServices[i % 5]} request handled in ${i % 90}ms`);
  }
  const kvServices = ["payments", "media", "notify", "export"];
  const kvLevels = ["info", "warn", "error"];
  for (let i = 0; i < 900; i++) {
    const ts = `2026-09-30T1${Math.floor(i / 360)}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    lines.push(`${ts} level=${kvLevels[i % 3]} svc=${kvServices[i % 4]} msg="upstream call ${i % 7} ok"`);
  }
  lines.push("", "TRACE something without any level marker", "2026-09-30T12:00:00Z media missing the bracket around level");
  return lines.join("\n") + "\n";
}

const BASE_TASKS = [
  T(
    "lru-cache",
    "Cache evicts the entries that were just used",
    "Users of our LRUCache report that right after touching a key it disappears, while keys nobody reads survive. Find the bug in lib/lru.mjs and fix it. Do not change the public interface. Verify with your own quick script before answering.",
    {
      "lib/lru.mjs": `export class LRUCache {
  constructor(capacity = 3) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value); // a read bumps the key to most recently used
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }
}
`,
    },
    {
      "lib/lru.mjs": [
        [
          "    while (this.map.size > this.capacity) {",
          "      const oldest = this.map.keys().next().value;",
          "      this.map.delete(oldest);",
          "    }",
        ].join("\n"),
        "    while (this.map.size > this.capacity) {\n      const keys = [...this.map.keys()];\n      this.map.delete(keys[keys.length - 1]);\n    }",
      ],
    },
    `import { LRUCache } from "./lib/lru.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const c = new LRUCache(3);
c.set("a", 1); c.set("b", 2); c.set("c", 3);
if (c.get("a") !== 1) fail("get(a) after fill should be 1");
c.set("d", 4); // full: 'b' is now the least recently used
if (c.has("b")) fail("b should have been evicted as LRU");
if (!c.has("a")) fail("a was just read and must survive");
if (!c.has("c") || !c.has("d")) fail("c and d must survive");

const c2 = new LRUCache(1);
c2.set("x", 1); c2.set("y", 2);
if (c2.size !== 1 || !c2.has("y")) fail("capacity 1 must keep only the newest key");
if (c2.get("x") !== undefined) fail("x must be gone");

console.log("PASS: LRU eviction is least-recently-used and reads bump recency");
`,
  ),

  T(
    "csv-quotes",
    "CSV parser breaks on quoted fields with commas and doubled quotes",
    "Run `node check.mjs`. The parser falls over on quoted fields that contain commas or escaped double-quotes, which breaks the import pipeline. Fix lib/csv.mjs — do not edit check.mjs or sample.csv; re-run the check to confirm before answering.",
    {
      "lib/csv.mjs": `export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\\r") {
      // tolerate CRLF
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}
`,
      "check.mjs": `import { readFileSync } from "node:fs";
import { parseCsv } from "./lib/csv.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = parseCsv(readFileSync("sample.csv", "utf8"));
if (rows.length !== 3) fail("expected 3 rows, got " + rows.length);
const [a, b, c] = rows;
if (a.join("|") !== 'name|note') fail("header mismatch: " + a.join("|"));
if (b.join("|") !== 'ada|wrote "code", daily') fail('quoted comma broken: ' + b.join("|"));
if (c.join("|") !== 'bob|said "hi" twice') fail('doubled quote broken: ' + c.join("|"));
console.log("PASS: quoted commas and escaped quotes parse correctly");
`,
      "sample.csv": `name,note
ada,"wrote ""code"", daily"
bob,"said ""hi"" twice"
`,
    },
    {
      "lib/csv.mjs": [
        [
          '      if (ch === \'"\') {',
          '        if (text[i + 1] === \'"\') {',
          '          field += \'"\';',
          "          i++;",
          "        } else {",
          "          inQuotes = false;",
          "        }",
        ].join("\n"),
        [
          '      if (ch === \'"\') {',
          "        inQuotes = false;",
          "        }",
        ].join("\n"),
      ],
    },
    `import { readFileSync } from "node:fs";
import { parseCsv } from "./lib/csv.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = parseCsv(readFileSync("sample.csv", "utf8"));
if (rows.length !== 3) fail("expected 3 rows, got " + rows.length);
const [a, b, c] = rows;
if (a.join("|") !== 'name|note') fail("header mismatch: " + a.join("|"));
if (b.join("|") !== 'ada|wrote "code", daily') fail('quoted comma broken: ' + b.join("|"));
if (c.join("|") !== 'bob|said "hi" twice') fail('doubled quote broken: ' + c.join("|"));

const extra = parseCsv('x,"a""b",' + "\\n");
if (extra[0][1] !== 'a"b') fail('inline doubled quotes broken: ' + JSON.stringify(extra[0]));
if (extra[0][2] !== "") fail("empty trailing field lost");

console.log("PASS: quoted commas and escaped quotes parse correctly");
`,
  ),

  T(
    "route-params",
    "Router matches paths that only prefix-match a segment",
    "Our HTTP router started dispatching /users-list to the /users/list route after a performance patch. Reproduce with a couple of lines against lib/router.mjs, fix the matching so every literal segment must match exactly (params still capture a whole segment), and make sure /users/42 still hits the /users/:id route. Verify before answering.",
    {
      "lib/router.mjs": `export function createRouter() {
  const routes = [];
  return {
    add(pattern, handler) {
      routes.push({ pattern, handler });
    },
    match(path) {
      for (const { pattern, handler } of routes) {
        const patternParts = pattern.split("/").filter(Boolean);
        const pathParts = path.split("/").filter(Boolean);
        if (patternParts.length !== pathParts.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < patternParts.length; i++) {
          const p = patternParts[i];
          if (p.startsWith(":")) {
            params[p.slice(1)] = decodeURIComponent(pathParts[i]);
          } else if (pathParts[i] !== p) {
            ok = false;
            break;
          }
        }
        if (ok) return { params, handler };
      }
      return null;
    },
  };
}
`,
    },
    {
      "lib/router.mjs": [
        [
          "          } else if (pathParts[i] !== p) {",
        ].join("\n"),
        "          } else if (!pathParts[i].startsWith(p)) {",
      ],
    },
    `import { createRouter } from "./lib/router.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const r = createRouter();
r.add("/users/list", () => "list");
r.add("/users/:id", (ctx) => "id:" + ctx.params.id);
r.add("/health", () => "health");

let m = r.match("/users/list");
if (!m || Object.keys(m.params).length !== 0 || typeof m.handler !== "function") fail("literal route must match with empty params");
m = r.match("/users/list-all");
if (!m || m.params.id !== "list-all") fail("/users/list-all must hit /users/:id, not the /users/list literal");
m = r.match("/users-list");
if (m) fail("prefix-only match dispatched: /users-list matched");
m = r.match("/users/42");
if (!m || m.params.id !== "42") fail("param route broken: " + JSON.stringify(m));
m = r.match("/users/42/posts");
if (m) fail("param must not eat extra segments");
m = r.match("/health");
if (!m || Object.keys(m.params).length !== 0) fail("health route lost");
if (r.match("/healthz")) fail("/healthz must not hit /health");
if (r.match("/nope") !== null) fail("unknown path must not match");
if (r.match("/users") !== null) fail("shorter path must not match");

console.log("PASS: literal segments match exactly, params capture one segment");
`,
  ),

  T(
    "retry-policy",
    "Retry helper re-runs validation failures that can never succeed",
    "withRetry in lib/retry.mjs is meant to retry only transient (RetryableError) failures, but a service outage last week showed it happily re-running validation errors too, and callers count attempts in metrics. Fix the retry condition: a non-retryable error must surface on its first attempt, a retryable one must be attempted exactly 1 + retries times. Verify with your own script (count calls) before answering.",
    {
      "lib/retry.mjs": `export class RetryableError extends Error {}

export async function withRetry(fn, { retries = 3, retryable = (e) => e instanceof RetryableError } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (!retryable(err) || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
    }
  }
  throw last;
}
`,
    },
    {
      "lib/retry.mjs": [
        [
          "      last = err;",
          "      if (!retryable(err) || attempt === retries) throw err;",
        ].join("\n"),
        "      last = err;\n      if (attempt === retries) throw err;",
      ],
    },
    `import { withRetry, RetryableError } from "./lib/retry.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let validationCalls = 0;
try {
  await withRetry(async () => {
    validationCalls++;
    throw new Error("ValidationError: bad input");
  }, { retries: 5 });
  fail("non-retryable error must propagate");
} catch (err) {
  if (validationCalls !== 1) fail("non-retryable ran " + validationCalls + " times, expected 1");
}

let transientCalls = 0;
const ok = await withRetry(async () => {
  transientCalls++;
  if (transientCalls < 3) throw new RetryableError("flaky");
  return "done";
}, { retries: 5 });
if (ok !== "done" || transientCalls !== 3) fail("retryable should succeed on 3rd call, ran " + transientCalls);

let exhausted = 0;
try {
  await withRetry(async () => {
    exhausted++;
    throw new RetryableError("always");
  }, { retries: 2 });
  fail("exhausted retries must throw");
} catch {}
if (exhausted !== 3) fail("expected 1 + 2 retries = 3 attempts, got " + exhausted);

console.log("PASS: retry policy retries only RetryableError and counts attempts correctly");
`,
  ),

  T(
    "deep-merge",
    "deepMerge silently mutates its base object",
    "Consumers pass cached config objects into deepMerge(base, patch) and their caches change under them. The function must never mutate its inputs: base or patch, at any depth. Patch arrays replace the base array wholesale; a null patch value clears the key. Fix lib/merge.mjs and verify with your own script that both inputs stay untouched.",
    {
      "lib/merge.mjs": `export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch === null || typeof patch !== "object") return patch;
  const baseIsObject = base !== null && typeof base === "object" && !Array.isArray(base);
  const out = baseIsObject ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}
`,
    },
    {
      "lib/merge.mjs": [
        [
          '  const baseIsObject = base !== null && typeof base === "object" && !Array.isArray(base);',
          "  const out = baseIsObject ? { ...base } : {};",
        ].join("\n"),
        '  const baseIsObject = base !== null && typeof base === "object" && !Array.isArray(base);\n  const out = baseIsObject ? base : {};',
      ],
    },
    `import { deepMerge } from "./lib/merge.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
const patch = { nested: { y: 3, z: 4 }, list: [9], b: 2 };
const baseCopy = JSON.parse(JSON.stringify(base));
const patchCopy = JSON.parse(JSON.stringify(patch));

const merged = deepMerge(base, patch);
if (merged.nested.y !== 3 || merged.nested.z !== 4 || merged.nested.x !== 1) fail("nested merge wrong: " + JSON.stringify(merged.nested));
if (merged.a !== 1 || merged.b !== 2) fail("scalar keys wrong");
if (JSON.stringify(merged.list) !== "[9]") fail("patch array must replace: " + JSON.stringify(merged.list));
if (JSON.stringify(base) !== JSON.stringify(baseCopy)) fail("base was mutated: " + JSON.stringify(base));
if (JSON.stringify(patch) !== JSON.stringify(patchCopy)) fail("patch was mutated");

const merged2 = deepMerge({ k: { v: 1 } }, { k: null });
if (merged2.k !== null) fail("null patch must clear the key");

console.log("PASS: deepMerge is non-mutating, arrays replace, null clears");
`,
  ),

  T(
    "async-pool",
    "Pool runs one task more than the concurrency limit",
    "Run `node check.mjs`. The pool is configured with limit 3 but a concurrency probe observes 4 tasks in flight, which the downstream API rate-limits. Fix lib/pool.mjs so at most `limit` tasks ever run at the same time, results keep their input order, and every task still runs. Do not edit check.mjs; re-run it before answering.",
    {
      "lib/pool.mjs": `export async function runPool(items, limit, worker) {
  let next = 0;
  let active = 0;
  let done = 0;
  let failed = false;
  const results = new Array(items.length);
  return await new Promise((resolve, reject) => {
    const launch = () => {
      while (active < limit && next < items.length && !failed) {
        const index = next++;
        active++;
        Promise.resolve(worker(items[index], index))
          .then((value) => {
            results[index] = value;
          })
          .catch((err) => {
            failed = true;
            reject(err);
          })
          .finally(() => {
            active--;
            done++;
            if (done === items.length) resolve(results);
            else launch();
          });
      }
    };
    if (items.length === 0) {
      resolve(results);
      return;
    }
    launch();
  });
}
`,
      "check.mjs": `import { runPool } from "./lib/pool.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let inFlight = 0;
let maxInFlight = 0;
const items = Array.from({ length: 12 }, (_, i) => i);
const results = await runPool(items, 3, async (n) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
  inFlight--;
  return n * 2;
});
if (maxInFlight > 3) fail("observed " + maxInFlight + " concurrent tasks, limit is 3");
if (results.length !== 12 || results.some((v, i) => v !== i * 2)) fail("results wrong or unordered: " + JSON.stringify(results));
const empty = await runPool([], 3, async () => 1);
if (empty.length !== 0) fail("empty input should give empty output");
console.log("PASS: pool respects the concurrency limit and keeps order");
`,
    },
    {
      "lib/pool.mjs": [
        [
          "      while (active < limit && next < items.length && !failed) {",
        ].join("\n"),
        "      while (active <= limit && next < items.length && !failed) {",
      ],
    },
    `import { runPool } from "./lib/pool.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let inFlight = 0;
let maxInFlight = 0;
const items = Array.from({ length: 12 }, (_, i) => i);
const results = await runPool(items, 3, async (n) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
  inFlight--;
  return n * 2;
});
if (maxInFlight > 3) fail("observed " + maxInFlight + " concurrent tasks, limit is 3");
if (maxInFlight !== 3) fail("pool underutilised: max " + maxInFlight + " of limit 3");
if (results.length !== 12 || results.some((v, i) => v !== i * 2)) fail("results wrong or unordered: " + JSON.stringify(results));

try {
  await runPool([1], 2, async () => { throw new Error("boom"); });
  fail("worker error must reject the pool");
} catch (err) {
  if (err.message !== "boom") fail("wrong rejection: " + err.message);
}
console.log("PASS: pool respects the concurrency limit, keeps order, propagates errors");
`,
  ),

  T(
    "html-escape",
    "Escaper double-escapes ampersand sequences",
    "Run `node check.mjs`. The template escaper corrupts text that legitimately contains entities or angle brackets after escaping (users see &amp;lt; rendered). Fix lib/escape.mjs — a single pass must replace each special character exactly once. Do not edit check.mjs; re-run it before answering.",
    {
      "lib/escape.mjs": `export function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (ch) => map[ch]);
}
`,
      "check.mjs": `import { escapeHtml } from "./lib/escape.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["a & b", "a &amp; b"],
  ["<b>bold</b>", "&lt;b&gt;bold&lt;/b&gt;"],
  ['say "hi"', "say &quot;hi&quot;"],
  ["it's", "it&#39;s"],
  ["&lt;tag&gt;", "&amp;lt;tag&amp;gt;"],
  ["", ""],
];
for (const [input, expected] of cases) {
  const actual = escapeHtml(input);
  if (actual !== expected) fail(JSON.stringify(input) + " -> " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}
console.log("PASS: escaping is a single correct pass");
`,
    },
    {
      "lib/escape.mjs": [
        [
          "export function escapeHtml(value) {",
          "  const map = { \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" };",
          "  return String(value).replace(/[&<>\"']/g, (ch) => map[ch]);",
          "}",
        ].join("\n"),
        [
          "export function escapeHtml(value) {",
          "  return String(value)",
          '    .replaceAll("<", "&lt;")',
          '    .replaceAll(">", "&gt;")',
          "    .replaceAll('\"', \"&quot;\")",
          "    .replaceAll(\"'\", \"&#39;\")",
          '    .replaceAll("&", "&amp;");',
          "}",
        ].join("\n"),
      ],
    },
    `import { escapeHtml } from "./lib/escape.mjs";
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["a & b", "a &amp; b"],
  ["<b>bold</b>", "&lt;b&gt;bold&lt;/b&gt;"],
  ['say "hi"', "say &quot;hi&quot;"],
  ["it's", "it&#39;s"],
  ["&lt;tag&gt;", "&amp;lt;tag&amp;gt;"],
  ["", ""],
  ["&&", "&amp;&amp;"],
];
for (const [input, expected] of cases) {
  const actual = escapeHtml(input);
  if (actual !== expected) fail(JSON.stringify(input) + " -> " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}
console.log("PASS: escaping is a single correct pass");
`,
  ),

  T(
    "chunk-split",
    "Chunker drops the last element of uneven arrays",
    "Callers of chunk(items, size) lose the final element whenever the array length is not a multiple of size, and pageCounts under-reports by one on uneven totals. Fix lib/chunk.mjs, keep the RangeError for non-positive sizes, and verify with your own script before answering.",
    {
      "lib/chunk.mjs": `export function chunk(arr, size) {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("size must be a positive integer");
  }
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function pageCounts(total, perPage) {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError("perPage must be a positive integer");
  }
  return Math.max(1, Math.ceil(total / perPage));
}
`,
    },
    {
      "lib/chunk.mjs": [
        [
          "  for (let i = 0; i < arr.length; i += size) {",
        ].join("\n"),
        "  for (let i = 0; i < arr.length - 1; i += size) {",
      ],
    },
    `import { chunk, pageCounts } from "./lib/chunk.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]])) fail("uneven chunk broken: " + JSON.stringify(chunk([1, 2, 3, 4, 5, 6, 7], 3)));
if (!deepEqual(chunk([1, 2], 2), [[1, 2]])) fail("even chunk broken");
if (!deepEqual(chunk([], 5), [])) fail("empty input must give empty output");
if (!deepEqual(chunk([1], 5), [[1]])) fail("single item lost");
for (const bad of [0, -1, 1.5]) {
  let threw = false;
  try { chunk([1], bad); } catch { threw = true; }
  if (!threw) fail("size " + bad + " must throw RangeError");
}
if (pageCounts(0, 10) !== 1) fail("0 items still has 1 (empty) page");
if (pageCounts(21, 10) !== 3) fail("21/10 must be 3 pages");
if (pageCounts(20, 10) !== 2) fail("20/10 must be 2 pages");
console.log("PASS: chunk keeps every element, pageCounts rounds up");
`,
  ),

  T(
    "env-precedence",
    "Environment variables no longer override file config",
    "Run `node check.mjs`. After a refactor, values from the environment lose to values from the file, which is backwards: precedence must be defaults < file < env. ENV keys map with __ as the nesting separator (DB__HOST → db.host). Fix lib/config.mjs without changing the interface; do not edit check.mjs; re-run it before answering.",
    {
      "lib/config.mjs": `export function loadConfig({ file = {}, env = {} } = {}) {
  const merged = clonePlain(file);
  const fromEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const segments = key.toLowerCase().split("__");
    let node = fromEnv;
    while (segments.length > 1) {
      const seg = segments.shift();
      node = typeof node[seg] === "object" && node[seg] !== null ? node[seg] : (node[seg] = {});
    }
    node[segments[0]] = value;
  }
  return deepMerge(merged, fromEnv);
}

function clonePlain(value) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? clonePlain(v) : v;
  }
  return out;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
        ? deepMerge(current, value)
        : value;
  }
  return out;
}
`,
      "check.mjs": `import { loadConfig } from "./lib/config.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cfg = loadConfig({
  file: { port: 8080, db: { host: "local", pool: 2 }, name: "svc" },
  env: { PORT: "9000", DB__HOST: "remote", DB__POOL: "8", NEW__FLAG: "true" },
});
if (cfg.port !== "9000") fail("env must override file for port, got " + JSON.stringify(cfg.port));
if (cfg.db.host !== "remote") fail("env must override file for db.host, got " + JSON.stringify(cfg.db));
if (cfg.db.pool !== "8") fail("env must set nested db.pool, got " + JSON.stringify(cfg.db));
if (cfg.name !== "svc") fail("file-only key lost: " + JSON.stringify(cfg));
if (cfg.new.flag !== "true") fail("new nested env key missing: " + JSON.stringify(cfg.new));

const onlyFile = loadConfig({ file: { a: 1 } });
if (onlyFile.a !== 1) fail("file-only config broken");
const onlyEnv = loadConfig({ env: { A__B: "x" } });
if (onlyEnv.a.b !== "x") fail("env-only config broken");

console.log("PASS: precedence is defaults < file < env, __ maps nesting");
`,
    },
    {
      "lib/config.mjs": [
        [
          "  return deepMerge(merged, fromEnv);",
        ].join("\n"),
        "  return deepMerge(fromEnv, merged);",
      ],
    },
    `import { loadConfig } from "./lib/config.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cfg = loadConfig({
  file: { port: 8080, db: { host: "local", pool: 2 }, name: "svc" },
  env: { PORT: "9000", DB__HOST: "remote", DB__POOL: "8", NEW__FLAG: "true" },
});
if (cfg.port !== "9000") fail("env must override file for port, got " + JSON.stringify(cfg.port));
if (cfg.db.host !== "remote") fail("env must override file for db.host, got " + JSON.stringify(cfg.db));
if (cfg.db.pool !== "8") fail("env must set nested db.pool, got " + JSON.stringify(cfg.db));
if (cfg.db.pool === 8) fail("env values arrive as strings, no coercion expected");
if (cfg.name !== "svc") fail("file-only key lost: " + JSON.stringify(cfg));
if (cfg.new.flag !== "true") fail("new nested env key missing: " + JSON.stringify(cfg.new));

const onlyFile = loadConfig({ file: { a: 1 } });
if (onlyFile.a !== 1) fail("file-only config broken");
const onlyEnv = loadConfig({ env: { A__B: "x" } });
if (onlyEnv.a.b !== "x") fail("env-only config broken");

console.log("PASS: precedence is defaults < file < env, __ maps nesting");
`,
  ),

  T(
    "stable-sort",
    "Report table sorts 10 before 2 and reorders the caller's array",
    "Two complaints about the reports table: rows with numeric values sort lexicographically (10 before 2), and after sorting, the caller's original array has been reordered. Fix lib/sortlib.mjs: numeric values compare numerically, everything else via localeCompare, desc flips the order, ties keep their input order, and the input array must never be mutated. Verify with your own script before answering.",
    {
      "lib/sortlib.mjs": `export function sortBy(rows, key, { desc = false } = {}) {
  const sign = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv)) * sign;
  });
}
`,
    },
    {
      "lib/sortlib.mjs": [
        [
          "  const sign = desc ? -1 : 1;",
          "  return [...rows].sort((a, b) => {",
          "    const av = a[key];",
          "    const bv = b[key];",
          "    if (av === bv) return 0;",
          '    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;',
          "    return String(av).localeCompare(String(bv)) * sign;",
          "  });",
        ].join("\n"),
        [
          "    const sign = desc ? -1 : 1;",
          "    return rows.sort((a, b) => {",
          "      const av = a[key];",
          "      const bv = b[key];",
          "      if (av === bv) return 0;",
          '      if (typeof av === "number" && typeof bv === "number") return String(av).localeCompare(String(bv)) * sign;',
          "      return String(av).localeCompare(String(bv)) * sign;",
          "    });",
        ].join("\n"),
      ],
    },
    `import { sortBy } from "./lib/sortlib.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rows = [{ v: 2 }, { v: 10 }, { v: 1 }];
const sorted = sortBy(rows, "v");
if (sorted.map((r) => r.v).join(",") !== "1,2,10") fail("numeric sort broken: " + sorted.map((r) => r.v));
if (rows.map((r) => r.v).join(",") !== "2,10,1") fail("input array was mutated");

const desc = sortBy(rows, "v", { desc: true });
if (desc.map((r) => r.v).join(",") !== "10,2,1") fail("desc broken: " + desc.map((r) => r.v));

const names = [{ n: "banana" }, { n: "Apple" }, { n: "cherry" }];
const byName = sortBy(names, "n");
if (byName.map((r) => r.n).join(",") !== "Apple,banana,cherry") fail("string sort broken: " + byName.map((r) => r.n));

const ties = [{ k: "x", i: 1 }, { k: "x", i: 2 }, { k: "x", i: 3 }];
const stable = sortBy(ties, "k");
if (stable.map((r) => r.i).join(",") !== "1,2,3") fail("ties must keep input order");

console.log("PASS: numeric compare, desc, non-mutating, stable ties");
`,
  ),

  T(
    "memoize-args",
    "Memoized function returns the same result for different arguments",
    "Run `node check.mjs`. After memoizing, calc(1, 2) and calc(1, 3) return the same number — the cache key ignores everything after the first argument. Fix lib/memoize.mjs so every distinct argument tuple gets its own cache entry while repeated tuples still hit the cache. Do not edit check.mjs; re-run it before answering.",
    {
      "lib/memoize.mjs": `export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const value = fn(...args);
    cache.set(key, value);
    return value;
  };
}
`,
      "check.mjs": `import { memoize } from "./lib/memoize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let calls = 0;
const calc = memoize((a, b) => {
  calls++;
  return a + "x" + b;
});

if (calc(1, 2) !== "1x2") fail("calc(1, 2) wrong: " + calc(1, 2));
if (calc(1, 3) !== "1x3") fail("calc(1, 3) must not collide with calc(1, 2), got " + calc(1, 3));
if (calls !== 2) fail("distinct tuples must each call the fn, calls=" + calls);
calc(1, 2);
if (calls !== 2) fail("repeated tuple must hit the cache, calls=" + calls);
console.log("PASS: cache keys use the full argument tuple");
`,
    },
    {
      "lib/memoize.mjs": [
        [
          '    const key = JSON.stringify(args);',
        ].join("\n"),
        '    const key = String(args[0]);',
      ],
    },
    `import { memoize } from "./lib/memoize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let calls = 0;
const calc = memoize((a, b) => {
  calls++;
  return a + "x" + b;
});

if (calc(1, 2) !== "1x2") fail("calc(1, 2) wrong: " + calc(1, 2));
if (calc(1, 3) !== "1x3") fail("calc(1, 3) must not collide with calc(1, 2), got " + calc(1, 3));
if (calls !== 2) fail("distinct tuples must each call the fn, calls=" + calls);
calc(1, 2);
if (calls !== 2) fail("repeated tuple must hit the cache, calls=" + calls);

const zero = memoize(() => { calls++; return 0; });
zero(); zero();
if (calls !== 3) fail("zero-arg memoization broken, calls=" + calls);
console.log("PASS: cache keys use the full argument tuple");
`,
  ),

  // ── Heavy family: wider modules, big data, multi-step reasoning. ──────────

  T(
    "checkout-cart",
    "Receipts book a cent short on some prices",
    "Support reports checkout receipts a cent short, but only on some prices: a 925-cent notebook with a 15% coupon must book a 139-cent discount, and the pipeline books 138; the same drift shows in tax on an 8% rate for a 4995-cent chair (must be 400). The money module documents the rounding policy — find where it is lost on the way to discounts and tax, and fix it there so every percent application follows the documented rule. Do not change the public interface of any module. Verify with your own script before answering.",
    {
      "src/money.mjs": `/**
 * All money math is integer cents. Percents apply with round-half-up so a
 * receipt total is independent of line order: every line rounds the same way.
 */
export function applyPercent(cents, percent) {
  return Math.round((cents * percent) / 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}
`,
      "src/catalog-data.mjs": `export const CATALOG = [
  { sku: "book-01", title: "Grid Systems", priceCents: 3200, taxable: true },
  { sku: "book-02", title: "The Timeless Way", priceCents: 2750, taxable: true },
  { sku: "cable-02", title: "USB-C cable 2m", priceCents: 1250, taxable: true },
  { sku: "mug-03", title: "Enamel mug", priceCents: 1450, taxable: false },
  { sku: "chair-04", title: "Folding chair", priceCents: 4995, taxable: true },
  { sku: "lamp-05", title: "Desk lamp", priceCents: 5900, taxable: true },
  { sku: "pen-06", title: "Gel pen 0.5", priceCents: 375, taxable: false },
  { sku: "note-07", title: "Notebook A5", priceCents: 925, taxable: false },
  { sku: "bag-08", title: "Tote bag", priceCents: 1850, taxable: false },
  { sku: "ssd-09", title: "SSD 1TB", priceCents: 11250, taxable: true },
  { sku: "kbd-10", title: "Mech keyboard", priceCents: 13475, taxable: true },
  { sku: "mouse-11", title: "Trackball", priceCents: 4125, taxable: true },
];
`,
      "src/catalog.mjs": `import { CATALOG } from "./catalog-data.mjs";

export function priceOf(sku) {
  const item = CATALOG.find((entry) => entry.sku === sku);
  if (!item) throw new Error(\`unknown sku: \${sku}\`);
  return item.priceCents;
}

export function has(sku) {
  return CATALOG.some((entry) => entry.sku === sku);
}

export const TAXABLE = new Set(CATALOG.filter((entry) => entry.taxable).map((entry) => entry.sku));
`,
      "src/cart.mjs": `import { has } from "./catalog.mjs";

export function createCart() {
  const lines = [];
  return {
    add(sku, qty = 1) {
      if (!Number.isInteger(qty) || qty < 1) throw new RangeError("qty must be a positive integer");
      if (!has(sku)) throw new Error(\`unknown sku: \${sku}\`);
      const existing = lines.find((l) => l.sku === sku);
      if (existing) existing.qty += qty;
      else lines.push({ sku, qty });
      return lines.length;
    },
    lines: () => lines.map((l) => ({ ...l })),
    get units() {
      return lines.reduce((sum, l) => sum + l.qty, 0);
    },
  };
}
`,
      "src/discounts.mjs": `import { applyPercent } from "./money.mjs";

/** Percent coupons apply to matching lines only; no coupon, no discount. */
export function lineDiscount(line, coupon) {
  if (!coupon || coupon.kind !== "percent") return 0;
  if (coupon.skus && !coupon.skus.includes(line.sku)) return 0;
  return applyPercent(line.subtotal, coupon.percent);
}
`,
      "src/tax.mjs": `import { applyPercent } from "./money.mjs";

/** Tax applies to the discounted line total of taxable lines only. */
export function lineTax(line, ratePercent) {
  if (!line.taxable) return 0;
  return applyPercent(line.total, ratePercent);
}
`,
      "src/pricing.mjs": `import { priceOf, TAXABLE } from "./catalog.mjs";
import { lineDiscount } from "./discounts.mjs";
import { lineTax } from "./tax.mjs";

/**
 * One priced line per cart line. Pipeline per line: subtotal = price × qty,
 * discount comes off the subtotal, tax applies to the discounted total.
 */
export function priceLines(cartLines, { coupon, taxPercent = 0 } = {}) {
  return cartLines.map((line) => {
    const subtotal = priceOf(line.sku) * line.qty;
    const discount = lineDiscount({ sku: line.sku, subtotal }, coupon);
    const total = subtotal - discount;
    const tax = lineTax({ total, taxable: TAXABLE.has(line.sku) }, taxPercent);
    return { sku: line.sku, qty: line.qty, subtotal, discount, tax, total: total + tax };
  });
}
`,
      "src/receipt.mjs": `import { formatCents } from "./money.mjs";

export function renderReceipt(lines) {
  const rows = lines.map(
    (l) => \`\${l.sku} x\${l.qty}: \${formatCents(l.subtotal)}, disc \${formatCents(l.discount)}, tax \${formatCents(l.tax)}, total \${formatCents(l.total)}\`,
  );
  const total = lines.reduce((sum, l) => sum + l.total, 0);
  return \`\${rows.join("\\n")}\\nTOTAL \${formatCents(total)}\`;
}
`,
      "src/index.mjs": `export { createCart } from "./cart.mjs";
export { priceLines } from "./pricing.mjs";
export { renderReceipt } from "./receipt.mjs";
`,
    },
    {
      // The "cleanup" replaced half-up rounding with truncation; the doc comment still promises round-half-up.
      "src/money.mjs": [
        "export function applyPercent(cents, percent) {\n  return Math.round((cents * percent) / 100);\n}",
        "export function applyPercent(cents, percent) {\n  return Math.floor((cents * percent) / 100);\n}",
      ],
    },
    `import { createCart, priceLines, renderReceipt } from "./src/index.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const coupon15 = { kind: "percent", percent: 15 };
const lines = priceLines([{ sku: "note-07", qty: 1 }, { sku: "book-02", qty: 1 }], { coupon: coupon15, taxPercent: 0 });
if (lines[0].discount !== 139) fail("15% of 925 must book 139, got " + lines[0].discount);
if (lines[1].discount !== 413) fail("15% of 2750 must book 413, got " + lines[1].discount);
if (lines[0].total !== 786 || lines[1].total !== 2337) fail("discounted totals wrong: " + JSON.stringify(lines));

const cart = createCart();
cart.add("chair-04");
const withTax = priceLines(cart.lines(), { taxPercent: 8 });
if (withTax[0].tax !== 400) fail("8% of 4995 must book 400, got " + withTax[0].tax);

const scoped = priceLines([{ sku: "kbd-10", qty: 1 }, { sku: "mouse-11", qty: 1 }], {
  coupon: { kind: "percent", percent: 10, skus: ["kbd-10"] },
  taxPercent: 8,
});
if (scoped[0].discount !== 1348) fail("10% of 13475 must book 1348, got " + scoped[0].discount);
if (scoped[1].discount !== 0) fail("coupon scoped to kbd-10 must not touch mouse-11");
if (scoped[0].tax !== 970) fail("8% of discounted 12127 must book 970, got " + scoped[0].tax);

const plain = priceLines([{ sku: "mug-03", qty: 2 }], { taxPercent: 8 });
if (plain[0].tax !== 0) fail("mug-03 is not taxable");
if (plain[0].total !== 2900) fail("untaxed total wrong");

try { priceLines([{ sku: "nope-99", qty: 1 }], {}); fail("unknown sku must throw"); }
catch {}
try { createCart().add("mug-03", 0); fail("qty 0 must throw"); }
catch {}

const receipt = renderReceipt(priceLines([{ sku: "pen-06", qty: 3 }], {}));
if (receipt !== "pen-06 x3: $11.25, disc $0.00, tax $0.00, total $11.25\\nTOTAL $11.25") {
  fail("receipt text wrong:\\n" + receipt);
}

console.log("PASS: percent math rounds half-up everywhere on the receipt pipeline");
`,
    300_000,
  ),

  T(
    "log-ingest",
    "Key=value log lines vanished from per-service reports",
    "Run `node check.mjs`. After the log shipper migration a third of our lines stopped reaching the per-service reports: the ones the new producer writes as key=value fields. The parser used to understand both shapes; a cleanup likely dropped one. Fix lib/ingest.mjs so bracket-shaped and key=value lines both ingest, non-log lines stay dropped, and the report numbers add up again. Do not edit check.mjs or data/service.log; re-run the check before answering.",
    {
      "lib/level.mjs": `const WEIGHTS = { debug: 10, info: 20, warn: 30, error: 40 };

export function levelWeight(level) {
  return WEIGHTS[String(level).toLowerCase()] ?? 0;
}
`,
      "lib/ingest.mjs": `import { levelWeight } from "./level.mjs";

/**
 * Producers write two shapes:
 *   2026-09-30T12:00:00Z [warn] payments retrying upstream
 *   2026-09-30T12:00:00Z level=warn svc=payments msg="retrying upstream"
 * Both must yield { ts, level, service, message, weight }; anything else is
 * not a log line and must be dropped.
 */
export function parseLine(line) {
  const bracket = line.match(/^(\\S+) \\[(\\w+)\\] (\\S+) (.*)$/);
  if (bracket) {
    return { ts: bracket[1], level: bracket[2].toLowerCase(), service: bracket[3], message: bracket[4], weight: levelWeight(bracket[2]) };
  }
  const kv = line.match(/^(\\S+) level=(\\w+) svc=(\\S+) msg="([^"]*)"\\s*$/);
  if (kv) {
    return { ts: kv[1], level: kv[2].toLowerCase(), service: kv[3], message: kv[4], weight: levelWeight(kv[2]) };
  }
  return null;
}

export function ingest(text) {
  const events = [];
  for (const line of text.split("\\n")) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}
`,
      "lib/aggregate.mjs": `/** Per-service totals: line count, error count, and the max weight seen. */
export function byService(events) {
  const out = new Map();
  for (const event of events) {
    const stats = out.get(event.service) ?? { total: 0, errors: 0, maxWeight: 0 };
    stats.total += 1;
    if (event.level === "error") stats.errors += 1;
    stats.maxWeight = Math.max(stats.maxWeight, event.weight);
    out.set(event.service, stats);
  }
  return out;
}
`,
      "lib/report.mjs": `/** Top services by total volume, ties broken by service name. */
export function topServices(counts, n) {
  return [...counts.entries()]
    .map(([service, stats]) => ({ service, ...stats }))
    .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service))
    .slice(0, n);
}
`,
      "data/service.log": buildServiceLog(),
      "check.mjs": `import { readFileSync } from "node:fs";
import { ingest } from "./lib/ingest.mjs";
import { byService } from "./lib/aggregate.mjs";
import { topServices } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const events = ingest(readFileSync("data/service.log", "utf8"));
if (events.length !== 2400) fail("expected 2400 events, got " + events.length);

const counts = byService(events);
if (counts.get("payments").total !== 525) fail("payments total wrong: " + JSON.stringify(counts.get("payments")));
if (counts.get("payments").errors !== 150) fail("payments errors wrong");
if (counts.get("media").total !== 525) fail("media total wrong");
if (counts.get("notify")?.total !== 225) fail("notify (key=value only) missing or wrong: " + JSON.stringify(counts.get("notify")));
if (counts.get("auth").maxWeight !== 40) fail("auth must have seen an error line");

const top = topServices(counts, 3);
if (top.map((s) => s.service).join(",") !== "media,payments,auth") {
  fail("top-3 wrong: " + top.map((s) => s.service).join(","));
}
console.log("PASS: both log shapes ingest, counts and top-3 match");
`,
    },
    {
      // The "cleanup" retired the key=value branch, dropping a third of the lines.
      "lib/ingest.mjs": [
        [
          '  const kv = line.match(/^(\\S+) level=(\\w+) svc=(\\S+) msg="([^"]*)"\\s*$/);',
          "  if (kv) {",
          "    return { ts: kv[1], level: kv[2].toLowerCase(), service: kv[3], message: kv[4], weight: levelWeight(kv[2]) };",
          "  }",
        ].join("\n"),
        '  // key=value shape was retired with the old shipper (PROD-4021)',
      ],
    },
    `import { readFileSync } from "node:fs";
import { parseLine, ingest } from "./lib/ingest.mjs";
import { byService } from "./lib/aggregate.mjs";
import { topServices } from "./lib/report.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const bracket = parseLine('2026-09-30T12:00:00Z [warn] payments retrying upstream');
if (!bracket || bracket.level !== "warn" || bracket.service !== "payments" || bracket.weight !== 30) {
  fail("bracket shape broken: " + JSON.stringify(bracket));
}
const kv = parseLine('2026-09-30T12:00:01Z level=ERROR svc=auth msg="token expired"');
if (!kv || kv.level !== "error" || kv.service !== "auth" || kv.weight !== 40) {
  fail("key=value shape broken: " + JSON.stringify(kv));
}
if (parseLine("not a log line") !== null) fail("garbage must be dropped");
if (parseLine("") !== null) fail("empty line must be dropped");

const events = ingest(readFileSync("data/service.log", "utf8"));
if (events.length !== 2400) fail("expected 2400 events from the big log, got " + events.length);
const counts = byService(events);
if (counts.get("payments")?.total !== 525 || counts.get("payments")?.errors !== 150) fail("payments stats wrong: " + JSON.stringify(counts.get("payments")));
if (counts.get("export")?.total !== 225) fail("export (key=value only) wrong: " + JSON.stringify(counts.get("export")));
const top = topServices(counts, 2);
if (top.map((s) => s.service).join(",") !== "media,payments") fail("top-2 wrong: " + top.map((s) => s.service).join(","));
console.log("PASS: both log shapes ingest, garbage dropped, counts match");
`,
    300_000,
  ),

  T(
    "patch-apply",
    "Multi-hunk patches fail with context mismatch when an earlier hunk shifts lines",
    "Our patch tooling started rejecting perfectly valid patches: any patch whose earlier hunk adds or removes lines makes the next hunk fail with 'context mismatch'. Applying hunks one at a time works, so the per-hunk matching is fine — the position tracking between hunks is not. Fix lib/apply.mjs so every hunk lands where its header says relative to the original file, whatever the earlier hunks did to the line count. Public API stays the same. Verify with your own script before answering.",
    {
      "lib/hunks.mjs": `/** Parse a patch: @@ -old,+new @@ headers with ' ' context, '-' del, '+' add lines. */
export function parsePatch(text) {
  const hunks = [];
  for (const m of text.matchAll(/@@ -(\\d+),(\\d+) \\+(\\d+),(\\d+) @@\\n((?:[ +-][^\\n]*\\n?)+)/g)) {
    const lines = m[5].split("\\n").filter((l) => l !== "");
    hunks.push({
      oldStart: Number(m[1]),
      oldLines: Number(m[2]),
      newStart: Number(m[3]),
      newLines: Number(m[4]),
      changes: lines.map((l) => ({ kind: l[0], text: l.slice(1) })),
    });
  }
  return hunks;
}
`,
      "lib/apply.mjs": `import { parsePatch } from "./hunks.mjs";

/**
 * Apply hunks to an array of lines. Header positions are 1-based in the
 * ORIGINAL file; when an earlier hunk changes the line count, later hunks
 * follow the accumulated offset, and every hunk's old block must match the
 * source exactly before anything is replaced.
 */
export function applyPatch(sourceLines, patchText) {
  const hunks = parsePatch(patchText);
  const out = [...sourceLines];
  let offset = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1 + offset;
    const oldBlock = [];
    const newBlock = [];
    for (const change of hunk.changes) {
      if (change.kind === "+") {
        newBlock.push(change.text);
      } else if (change.kind === "-") {
        oldBlock.push(change.text);
      } else {
        oldBlock.push(change.text);
        newBlock.push(change.text);
      }
    }
    for (let i = 0; i < oldBlock.length; i++) {
      if (out[start + i] !== oldBlock[i]) {
        throw new Error(
          \`context mismatch at line \${start + i + 1}: expected \${JSON.stringify(oldBlock[i])}, got \${JSON.stringify(out[start + i])}\`,
        );
      }
    }
    out.splice(start, oldBlock.length, ...newBlock);
    offset += newBlock.length - oldBlock.length;
  }
  return out;
}
`,
      "samples/app.txt": `// app entry
import { template } from "./template.mjs"
import { config } from "./config.mjs"

function main() {
  const users = load()
  for (const user of users) {
    console.log(render(user))
  }
}

main()
`,
      "patches/feature.patch": `@@ -2,1 +2,3 @@
 import { template } from "./template.mjs"
+import { validate } from "./validate.mjs"
+import { cache } from "./cache.mjs"
@@ -6,3 +8,3 @@
   const users = load()
-  for (const user of users) {
+  for (const user of cache.warm(users)) {
     console.log(render(user))
`,
      "patches/fixup.patch": `@@ -7,2 +7,2 @@
-function main() {
+async function main() {
   const users = load()
`,
      "check.mjs": `import { readFileSync } from "node:fs";
import { applyPatch } from "./lib/apply.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const read = (p) => readFileSync(p, "utf8").split("\\n");

const source = read("samples/app.txt");
const afterFeature = applyPatch(source, read("patches/feature.patch").join("\\n"));
if (afterFeature[2] !== 'import { validate } from "./validate.mjs"') fail("hunk 1 lost: " + afterFeature[2]);
if (afterFeature[8] !== "  for (const user of cache.warm(users)) {") fail("hunk 2 landed wrong: " + afterFeature[8]);
if (afterFeature.length !== 15) fail("line count wrong: " + afterFeature.length);

const afterFixup = applyPatch(afterFeature, read("patches/fixup.patch").join("\\n"));
if (afterFixup[6] !== "async function main() {") fail("fixup hunk lost: " + JSON.stringify(afterFixup[6]));
if (afterFixup.length !== 15) fail("fixup must not change the line count");

let threw = false;
try {
  applyPatch(source, "@@ -100,1 +100,1 @@\\n-no such line\\n");
} catch {
  threw = true;
}
if (!threw) fail("a patch whose context is absent must throw");

console.log("PASS: multi-hunk patches track offsets, bad context still throws");
`,
    },
    {
      // The "cleanup" decided headers are absolute and dropped the accumulation.
      "lib/apply.mjs": [
        "    out.splice(start, oldBlock.length, ...newBlock);\n    offset += newBlock.length - oldBlock.length;",
        "    out.splice(start, oldBlock.length, ...newBlock);\n    // headers are absolute, nothing to accumulate",
      ],
    },
    `import { applyPatch } from "./lib/apply.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const source = ["one", "two", "three", "four", "five"];
// Both hunks in ONE patch: the second must follow the +2 lines the first added.
const combined = "@@ -2,1 +2,3 @@\\n two\\n+two and a half\\n+two and three quarters\\n@@ -4,2 +6,2 @@\\n four\\n-five\\n+FIVE!\\n";
const out = applyPatch(source, combined);
if (out.join("|") !== "one|two|two and a half|two and three quarters|three|four|FIVE!") {
  fail("hunk after an inserting hunk landed wrong: " + out.join("|"));
}

// A deleting hunk shifts the next one back by one.
const shrink = "@@ -1,2 +1,1 @@\\n one\\n-two\\n@@ -4,2 +3,2 @@\\n four\\n-five\\n+4.5\\n";
const shrunk = applyPatch(source, shrink);
if (shrunk.join("|") !== "one|three|four|4.5") {
  fail("hunk after a deleting hunk landed wrong: " + shrunk.join("|"));
}

const src = ["a", "b", "c"];
const frozen = applyPatch(src, "@@ -1,1 +1,1 @@\\n-a\\n+A!\\n");
if (src.join("|") !== "a|b|c") fail("input array was mutated");
if (frozen.join("|") !== "A!|b|c") fail("single-hunk replace broken: " + frozen.join("|"));

if (applyPatch(src, "").join("|") !== "a|b|c") fail("empty patch must be a no-op");

let threw = false;
try { applyPatch(src, "@@ -2,1 +2,1 @@\\n NOT-TWO\\n"); } catch { threw = true; }
if (!threw) fail("mismatched context must throw");

console.log("PASS: offsets accumulate across hunks, matching stays exact");
`,
    300_000,
  ),
];

// Difficulty bands for the original 14 tasks; the module-defined tasks
// (bench/swe-tasks/*.mjs) carry their band in the def() call.
const DIFFICULTY = {
  "lru-cache": "easy",
  "csv-quotes": "easy",
  "html-escape": "easy",
  "chunk-split": "easy",
  "memoize-args": "easy",
  "route-params": "medium",
  "retry-policy": "medium",
  "deep-merge": "medium",
  "async-pool": "medium",
  "env-precedence": "medium",
  "stable-sort": "medium",
  "checkout-cart": "hard",
  "log-ingest": "hard",
  "patch-apply": "hard",
};

const TASKS_LIST = [
  ...BASE_TASKS.map((t) => ({ ...t, difficulty: DIFFICULTY[t.id] ?? "medium" })),
  ...easyTasks,
  ...mediumTasks,
  ...hardTasks,
];
{
  const ids = new Set(TASKS_LIST.map((t) => t.id));
  if (ids.size !== TASKS_LIST.length) {
    const seen = new Set();
    for (const t of TASKS_LIST) {
      if (seen.has(t.id)) throw new Error("duplicate task id: " + t.id);
      seen.add(t.id);
    }
  }
}

for (const t of TASKS_LIST) {
  const dir = path.join(TASKS, t.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: t.id, title: t.title, prompt: t.prompt, timeoutMs: t.timeoutMs, difficulty: t.difficulty }, null, 2) + "\n");
  writeFileSync(path.join(dir, "verify.mjs"), t.verify);
  for (const [rel, content] of Object.entries(t.files)) {
    const p = path.join(dir, "fixture", rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  // The fixture ships the BUGGY sources: apply the planted bug over the fixed ones.
  for (const [rel, [from, to]] of Object.entries(t.buggy)) {
    const p = path.join(dir, "fixture", rel);
    const fixed = t.files[rel];
    if (!fixed.includes(from)) throw new Error(`${t.id}: bug pattern not found in ${rel}`);
    writeFileSync(p, fixed.replace(from, to));
  }
  console.log(`wrote ${t.id}`);
}

// Validate: verifier must FAIL on the buggy fixture and PASS on the fixed
// sources. The bench runs verify.mjs inside the workspace (fixture at the
// root), so mirror that: copy the verifier into a scratch copy of the fixture.
import { cpSync } from "node:fs";
for (const t of TASKS_LIST) {
  const dir = path.join(TASKS, t.id);
  const ws = path.join(TASKS, t.id + ".validate");
  rmSync(ws, { recursive: true, force: true });
  cpSync(path.join(dir, "fixture"), ws, { recursive: true });
  writeFileSync(path.join(ws, "verify.mjs"), t.verify);
  const run = () => spawnSync(process.execPath, ["verify.mjs"], { cwd: ws, encoding: "utf8" });
  let res = run();
  if (res.status === 0) throw new Error(`${t.id}: verifier PASSED on the buggy fixture — the verify is too weak`);
  for (const [rel, [from, to]] of Object.entries(t.buggy)) {
    if (!t.files[rel].includes(from)) throw new Error(`${t.id}: bug pattern not found in ${rel}`);
    writeFileSync(path.join(ws, rel), t.files[rel]);
  }
  res = run();
  if (res.status !== 0) {
    console.error(`${t.id} FIXED-RUN OUTPUT:\n${(res.stdout || "") + (res.stderr || "")}`);
    throw new Error(`${t.id}: verifier FAILED on the fixed sources`);
  }
  rmSync(ws, { recursive: true, force: true });
  console.log(`OK ${t.id}: fails buggy, passes fixed`);
}
