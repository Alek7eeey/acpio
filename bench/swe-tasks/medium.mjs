// swe-* tasks, medium band: trickier logic or a two-module trail — the root
// cause is one step removed from the symptom, or the edge cases carry the
// bug. Same generator rule: verifier fails on the planted bug, passes on
// the fixed sources.
import { def } from "./support.mjs";

export default [
  def(
    "medium",
    "event-emitter-once",
    "once() listeners keep firing and cannot be removed",
    "The telemetry bus leaks handlers: a listener registered with once('ping', fn) runs on EVERY later emit, and off('ping', fn) with the original function does not remove it either. The header of lib/emitter.mjs states the contract: once must fire exactly once and be removable both via its unsubscribe function and via plain off(event, fn) with the ORIGINAL function. Fix lib/emitter.mjs and verify with your own script before answering.",
    {
      "lib/emitter.mjs": `/**
 * Minimal event emitter. \`once\` registers a listener for a single emit and
 * MUST be removable afterwards both via its unsubscribe function and via
 * plain off(event, fn) with the ORIGINAL function — once-wrappers are
 * marked with .original so off can resolve them.
 */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    wrapped.original = fn;
    this.on(event, wrapped);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return;
    let index = list.indexOf(fn);
    if (index === -1) index = list.findIndex((handler) => handler.original === fn);
    if (index !== -1) list.splice(index, 1);
  }

  emit(event, ...args) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
  }

  listenerCount(event) {
    return (this.listeners.get(event) ?? []).length;
  }
}
`,
    },
    {
      "lib/emitter.mjs": [
        [
          "  once(event, fn) {",
          "    const wrapped = (...args) => {",
          "      this.off(event, wrapped);",
          "      fn(...args);",
          "    };",
          "    wrapped.original = fn;",
          "    this.on(event, wrapped);",
          "    return () => this.off(event, fn);",
          "  }",
        ].join("\n"),
        [
          "  once(event, fn) {",
          "    const wrapped = (...args) => fn(...args);",
          "    this.on(event, wrapped);",
          "    return () => this.off(event, fn);",
          "  }",
        ].join("\n"),
      ],
    },
    `import { Emitter } from "./lib/emitter.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const e = new Emitter();
let hits = 0;
e.once("ping", () => hits++);
e.emit("ping");
e.emit("ping");
e.emit("ping");
if (hits !== 1) fail("once must fire exactly once, fired " + hits);
if (e.listenerCount("ping") !== 0) fail("once listener must be gone after firing");

let direct = 0;
const fn = () => direct++;
e.once("pong", fn);
e.off("pong", fn);
e.emit("pong");
if (direct !== 0) fail("off(event, fn) must remove a not-yet-fired once listener");
if (e.listenerCount("pong") !== 0) fail("listener list must be empty after off");

const order = [];
const e2 = new Emitter();
const offA = e2.on("x", () => order.push("a"));
e2.on("x", () => order.push("b"));
e2.emit("x");
if (order.join("") !== "ab") fail("listeners must run in registration order: " + order.join(""));
offA();
if (e2.listenerCount("x") !== 1) fail("unsubscribe function must remove its listener");

const e3 = new Emitter();
const seen = [];
e3.once("m", (...a) => seen.push(a));
e3.emit("m", 1, 2);
if (JSON.stringify(seen) !== "[[1,2]]") fail("emit args must reach the listener: " + JSON.stringify(seen));

console.log("PASS: once fires once and is removable both ways");
`,
  ),

  def(
    "medium",
    "ttl-cache-clock",
    "Hot keys never expire: reads extend the TTL",
    "The session cache holds entries forever under read load: an entry set with ttl=100ms and read every 90ms is still alive a minute later. The contract in lib/ttl.mjs is that an entry lives ttl ms from its SET — reads must never extend it. The clock is injectable, so write a script with a fake clock and verify expiry, size, purge, has and overwrite-restarts-ttl before answering.",
    {
      "lib/ttl.mjs": `/**
 * TTL cache: an entry lives \`ttl\` ms from its SET — reads never extend it.
 * The clock is injectable so expiry is testable without real waiting.
 */
export function createTtlCache({ ttl, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttl) || ttl <= 0) throw new RangeError("ttl must be a positive number of ms");
  const map = new Map();
  const alive = (entry, at) => at < entry.expiresAt;
  return {
    set(key, value) {
      map.set(key, { value, expiresAt: now() + ttl });
    },
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (!alive(entry, now())) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    has(key) {
      const entry = map.get(key);
      return !!entry && alive(entry, now());
    },
    purge() {
      const t = now();
      for (const [key, entry] of map) {
        if (!alive(entry, t)) map.delete(key);
      }
      return map.size;
    },
    get size() {
      const t = now();
      let n = 0;
      for (const entry of map.values()) {
        if (alive(entry, t)) n++;
      }
      return n;
    },
  };
}
`,
    },
    {
      "lib/ttl.mjs": [
        [
          "      if (!alive(entry, now())) {",
          "        map.delete(key);",
          "        return undefined;",
          "      }",
          "      return entry.value;",
        ].join("\n"),
        "      entry.expiresAt = now() + ttl; // reads keep hot entries alive\n      return entry.value;",
      ],
    },
    `import { createTtlCache } from "./lib/ttl.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const cache = createTtlCache({ ttl: 100, now: () => t });
cache.set("a", 1);
if (cache.get("a") !== 1) fail("fresh entry must be readable");
if (cache.size !== 1) fail("size must count a live entry");
t = 90;
if (cache.get("a") !== 1) fail("entry must live until ttl after its set");
t = 150;
if (cache.get("a") !== undefined) fail("reads must NOT extend the ttl: entry expired at 100");
if (cache.has("a")) fail("has must respect expiry");
if (cache.size !== 0) fail("size must not count expired entries, got " + cache.size);

cache.set("b", 2);
if (cache.purge() !== 1) fail("purge must keep live entries");
t = 300;
if (cache.purge() !== 0) fail("purge must drop expired entries");

cache.set("c", 3);
t = 350;
cache.set("c", 4);
if (cache.get("c") !== 4) fail("overwrite must keep the value");
t = 420;
if (cache.get("c") !== 4) fail("ttl must run from the overwrite, not the first set");
t = 460;
if (cache.get("c") !== undefined) fail("overwritten entry must expire 100ms after the overwrite");

let threw = false;
try { createTtlCache({ ttl: 0 }); } catch { threw = true; }
if (!threw) fail("ttl must be a positive number");

console.log("PASS: ttl runs from set, reads do not extend it");
`,
  ),

  def(
    "medium",
    "topo-sort-cycle",
    "Build planner silently emits a partial order on dependency cycles",
    "The task planner hangs or skips jobs when two tasks depend on each other: lib/topo.mjs returns a partial order instead of failing, and the runner happily executes the truncated plan. The documented contract: a cycle is a hard Error mentioning the stuck nodes — a partial order must never be returned silently. Fix lib/topo.mjs and verify with your own script (valid DAG order, diamond, empty graph, 3-cycle, self-edge, unknown node) before answering.",
    {
      "lib/topo.mjs": `/**
 * Kahn topological sort. \`edges\` are [before, after] pairs over \`nodes\`.
 * Returns every node exactly once, each edge respecting order. A cycle is a
 * hard error — Error("cycle among: ...") — a partial order must never be
 * returned silently.
 */
export function topoSort(nodes, edges = []) {
  const nodeSet = new Set(nodes);
  const indegree = new Map([...nodeSet].map((n) => [n, 0]));
  const next = new Map([...nodeSet].map((n) => [n, []]));
  for (const [from, to] of edges) {
    if (!nodeSet.has(from) || !nodeSet.has(to)) throw new Error("unknown node in edge: " + from + " -> " + to);
    next.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  const out = [];
  while (ready.length > 0) {
    const n = ready.shift();
    out.push(n);
    for (const m of next.get(n)) {
      indegree.set(m, indegree.get(m) - 1);
      if (indegree.get(m) === 0) ready.push(m);
    }
  }
  if (out.length !== nodeSet.size) {
    const stuck = [...indegree].filter(([, d]) => d > 0).map(([n]) => n).sort();
    throw new Error("cycle among: " + stuck.join(", "));
  }
  return out;
}
`,
    },
    {
      "lib/topo.mjs": [
        [
          "  if (out.length !== nodeSet.size) {",
          '    const stuck = [...indegree].filter(([, d]) => d > 0).map(([n]) => n).sort();',
          '    throw new Error("cycle among: " + stuck.join(", "));',
          "  }",
          "  return out;",
        ].join("\n"),
        "  // leftover nodes mean a cycle; return the partial order for now (PROD-4203)\n  return out;",
      ],
    },
    `import { topoSort } from "./lib/topo.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const edges = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["d", "e"]];
const order = topoSort(["a", "b", "c", "d", "e"], edges);
if (order.length !== 5) fail("every node must be returned, got " + order.length);
const pos = new Map(order.map((n, i) => [n, i]));
for (const [from, to] of edges) {
  if (pos.get(from) >= pos.get(to)) fail("edge " + from + "->" + to + " violated: " + order.join(","));
}
if (topoSort([], []).length !== 0) fail("empty graph");
if (topoSort(["x"], []).join(",") !== "x") fail("single node");

let threw = false;
try { topoSort(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]); }
catch (err) { threw = /cycle/.test(err.message); }
if (!threw) fail("a 3-cycle must throw with a cycle message, got none");

threw = false;
try { topoSort(["a"], [["a", "a"]]); }
catch { threw = true; }
if (!threw) fail("a self-edge must throw");

threw = false;
try { topoSort(["a"], [["a", "ghost"]]); }
catch { threw = true; }
if (!threw) fail("an edge to an unknown node must throw");

console.log("PASS: topo sort orders DAGs and refuses cycles");
`,
  ),

  def(
    "medium",
    "merge-intervals",
    "Booking calendar double-counts back-to-back ranges",
    "The busy/free view double-counts time: adjacent bookings like 09:00-10:00 and 10:00-11:00 no longer merge, so totalCovered reports twice the occupied time across the touch point. Per the header of lib/intervals.mjs, touching ranges (end === next start) MUST merge — a zero-length gap is no gap. Fix lib/intervals.mjs and verify with your own script (touching, overlapping, contained, disjoint, empty, input not mutated, totalCovered) before answering.",
    {
      "lib/intervals.mjs": `/**
 * Merge [start, end] ranges. Touching ranges (end === next start) merge —
 * a zero-length gap is no gap. Input is never mutated; result is sorted by
 * start. totalCovered sums lengths after merging.
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      out.push({ start: current.start, end: current.end });
    }
  }
  return out;
}

export function totalCovered(intervals) {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}
`,
    },
    {
      "lib/intervals.mjs": [
        "    if (last && current.start <= last.end) {",
        "    if (last && current.start < last.end) {",
      ],
    },
    `import { mergeIntervals, totalCovered } from "./lib/intervals.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(mergeIntervals([{ start: 0, end: 2 }, { start: 2, end: 4 }]), [{ start: 0, end: 4 }])) {
  fail("touching ranges must merge: " + JSON.stringify(mergeIntervals([{ start: 0, end: 2 }, { start: 2, end: 4 }])));
}
if (!eq(mergeIntervals([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 2, end: 6 }]), [{ start: 0, end: 8 }])) fail("overlap + containment must merge");
if (!eq(mergeIntervals([{ start: 0, end: 1 }, { start: 5, end: 6 }]), [{ start: 0, end: 1 }, { start: 5, end: 6 }])) fail("disjoint ranges must stay");
if (!eq(mergeIntervals([{ start: 0, end: 10 }, { start: 2, end: 3 }]), [{ start: 0, end: 10 }])) fail("containment must keep the outer end");
if (!eq(mergeIntervals([]), [])) fail("empty input");
const input = [{ start: 1, end: 2 }];
mergeIntervals(input);
if (!eq(input, [{ start: 1, end: 2 }])) fail("input must not be mutated");
if (totalCovered([{ start: 0, end: 10 }, { start: 5, end: 6 }, { start: 20, end: 25 }]) !== 15) fail("totalCovered must merge before summing");
if (totalCovered([]) !== 0) fail("totalCovered empty");

console.log("PASS: ranges merge on touch, input stays intact");
`,
  ),

  def(
    "medium",
    "glob-match",
    "Ignore patterns match files one directory too deep",
    "After the matcher refactor, 'src/*.js' suddenly matches 'src/deep/a.js', so files are excluded from linting that should be checked. The contract in lib/glob.mjs: '?' matches one char except '/', '*' matches a run EXCEPT '/', only '**' crosses '/', everything else is literal, full-path match. Fix lib/glob.mjs and verify with your own script (single star, double star, question mark, literal dots, non-matches) before answering.",
    {
      "lib/glob.mjs": `/**
 * Mini glob for path patterns: '?' matches exactly one char except '/',
 * '*' matches a run of chars except '/', '**' matches any run including
 * '/'. Everything else is literal (regex metachars included). The pattern
 * must cover the whole path.
 */
export function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else if ("\\\\^$.|+()[]{}".includes(ch)) {
      source += "\\\\" + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp("^" + source + "$");
}

export function match(pattern, path) {
  return globToRegExp(pattern).test(path);
}
`,
    },
    {
      "lib/glob.mjs": [
        '        source += "[^/]*";',
        '        source += ".*"; // single star may cross \'/\' now (PROD-4199)',
      ],
    },
    `import { match } from "./lib/glob.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const yes = [
  ["src/*.js", "src/a.js"],
  ["src/*.js", "src/.hidden.js"],
  ["*.md", "readme.md"],
  ["a?c", "abc"],
  ["**", "any/deep/path.txt"],
  ["logs/**/*.log", "logs/2026/09/app.log"],
  ["logs/**/*.log", "logs/deep/deeper/x.log"],
  ["a*b", "ab"],
  ["a*b", "a-b"],
  ["v1.2.json", "v1.2.json"],
];
const no = [
  ["src/*.js", "src/deep/a.js"],
  ["*.md", "docs/readme.md"],
  ["a?c", "a/c"],
  ["a?c", "ac"],
  ["v1.2.json", "v1x2json"],
  ["logs/**/*.log", "other/app.log"],
  ["a*b", "a/b"],
];
for (const [pattern, path] of yes) {
  if (!match(pattern, path)) fail("expected match: " + pattern + " vs " + path);
}
for (const [pattern, path] of no) {
  if (match(pattern, path)) fail("expected NO match: " + pattern + " vs " + path);
}

console.log("PASS: single star stays inside a segment, double star crosses");
`,
  ),

  def(
    "medium",
    "settle-all",
    "Batch status endpoint dies on the first failing job",
    "The batch runner resolves every job's outcome individually, but one rejected job now rejects the whole batch and the other results are lost. lib/settle.mjs documents the contract: run all tasks concurrently, NEVER reject, and resolve in input order with { ok: true, value } / { ok: false, reason }. Fix lib/settle.mjs and verify with your own script: mixed success/failure, resolutions landing in input order even when the last task settles first, empty input.",
    {
      "lib/settle.mjs": `/**
 * Run every task concurrently and NEVER reject: the result is an array in
 * INPUT order — { ok: true, value } for fulfilled tasks, { ok: false,
 * reason } for rejected ones. A failing task must not hide the outcomes of
 * the others.
 */
export async function settleAll(tasks) {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  return results.map((r) =>
    r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, reason: r.reason },
  );
}
`,
    },
    {
      "lib/settle.mjs": [
        [
          "  const results = await Promise.allSettled(tasks.map((task) => task()));",
          "  return results.map((r) =>",
          '    r.status === "fulfilled" ? { ok: true, value: r.value } : { ok: false, reason: r.reason },',
          "  );",
        ].join("\n"),
        [
          "  const values = await Promise.all(tasks.map((task) => task()));",
          "  return values.map((value) => ({ ok: true, value }));",
        ].join("\n"),
      ],
    },
    `import { settleAll } from "./lib/settle.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const d0 = deferred();
const d1 = deferred();
const d2 = deferred();
let result;
try {
  const pending = settleAll([
    () => d0.promise,
    () => d1.promise,
    () => d2.promise,
    () => Promise.resolve("instant"),
  ]);
  d1.resolve("second");
  d2.reject(new Error("nope"));
  d0.resolve("first");
  result = await pending;
} catch (err) {
  fail("settleAll must never reject, threw: " + err.message);
}
if (!Array.isArray(result) || result.length !== 4) fail("expected one outcome per task");
if (!result[0].ok || result[0].value !== "first") fail("input order must be preserved: " + JSON.stringify(result[0]));
if (!result[3].ok || result[3].value !== "instant") fail("fast task lost");
if (result[2].ok !== false || result[2].reason?.message !== "nope") fail("rejection must settle as ok:false with the reason: " + JSON.stringify(result[2]));
if (result[1].value !== "second") fail("late resolution must still land in place");

const allOk = await settleAll([() => Promise.resolve(1), () => Promise.resolve(2)]);
if (!allOk.every((r) => r.ok) || allOk.map((r) => r.value).join(",") !== "1,2") fail("all-success case broken");

const empty = await settleAll([]);
if (empty.length !== 0) fail("empty input must give empty output");

console.log("PASS: settleAll never rejects and keeps input order");
`,
  ),

  def(
    "medium",
    "config-schema-validate",
    "Fresh deployments fail validation: defaults are never applied",
    "Deploying with an empty config file fails validation with 'port: required' although the schema gives port a default of 8080. The pipeline in lib/validate.mjs is supposed to apply defaults from lib/schema.mjs BEFORE checking fields — the header of schema.mjs states that order. Find where the order is lost, fix it without changing any interface, and verify with your own script (defaults satisfy required, type errors, enum errors, dot paths, input not mutated, multiple sorted errors) before answering.",
    {
      "lib/schema.mjs": `/**
 * Field spec: { path: "db.port", type: "string"|"number"|"boolean",
 * required?, default?, enum? }. Defaults are applied BEFORE checks: a field
 * with a default never reports "required". Errors are "path: message"
 * strings, sorted for stable output.
 */
export function applyDefaults(spec, config) {
  const out = deepClone(config);
  for (const field of spec) {
    if (field.default === undefined) continue;
    if (pick(out, field.path) === undefined) setPath(out, field.path, field.default);
  }
  return out;
}

export function checkFields(spec, config) {
  const errors = [];
  for (const field of spec) {
    const value = pick(config, field.path);
    if (value === undefined) {
      if (field.required) errors.push(field.path + ": required");
      continue;
    }
    if (field.type && typeof value !== field.type) {
      errors.push(field.path + ": expected " + field.type + ", got " + typeof value);
    }
    if (field.enum && !field.enum.includes(value)) {
      errors.push(field.path + ": must be one of " + field.enum.join(" | "));
    }
  }
  return errors.sort();
}

function pick(obj, path) {
  let current = obj;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(obj, path, value) {
  const segments = path.split(".");
  let current = obj;
  while (segments.length > 1) {
    const segment = segments.shift();
    if (current[segment] === null || typeof current[segment] !== "object") current[segment] = {};
    current = current[segment];
  }
  current[segments[0]] = value;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}
`,
      "lib/validate.mjs": `import { applyDefaults, checkFields } from "./schema.mjs";

/** Defaults first, then checks — validateConfig never mutates its input. */
export function validateConfig(spec, config) {
  return checkFields(spec, applyDefaults(spec, config));
}
`,
    },
    {
      "lib/validate.mjs": [
        "  return checkFields(spec, applyDefaults(spec, config));",
        "  return checkFields(spec, config); // defaults pass skipped (PROD-4210)",
      ],
    },
    `import { validateConfig } from "./lib/validate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const spec = [
  { path: "port", type: "number", required: true, default: 8080 },
  { path: "db.host", type: "string", required: true },
  { path: "db.pool", type: "number", default: 5 },
  { path: "log.level", type: "string", enum: ["debug", "info", "warn", "error"], default: "info" },
];

if (!eq(validateConfig(spec, {}), ["db.host: required"])) fail("empty config: only db.host (no default) may be required: " + JSON.stringify(validateConfig(spec, {})));
if (!eq(validateConfig(spec, { db: { host: "db1" } }), [])) fail("partial config with defaults must validate");
if (!eq(validateConfig(spec, { port: "8080", db: { host: "db1" } }), ["port: expected number, got string"])) fail("type error must be reported with the dot path");
if (!eq(validateConfig(spec, { db: { host: "db1", pool: "x" } }), ["db.pool: expected number, got string"])) fail("nested type error");
if (!eq(validateConfig(spec, { db: { host: "db1" }, log: { level: "verbose" } }), ["log.level: must be one of debug | info | warn | error"])) fail("enum violation");
if (!eq(validateConfig(spec, { port: 1 }), ["db.host: required"])) fail("missing required without default");

const config = { db: { host: "db1" } };
validateConfig(spec, config);
if (!eq(config, { db: { host: "db1" } })) fail("validateConfig must not mutate its input");

const noDefaults = [{ path: "a.b", required: true }, { path: "x", type: "boolean" }];
if (!eq(validateConfig(noDefaults, { x: "yes" }), ["a.b: required", "x: expected boolean, got string"])) {
  fail("multiple errors expected: " + JSON.stringify(validateConfig(noDefaults, { x: "yes" })));
}

console.log("PASS: defaults apply before checks; errors use dot paths");
`,
  ),

  def(
    "medium",
    "markdown-toc",
    "TOC lists headings that live inside code fences",
    "The docs site's table of contents shows entries like 'this is NOT a heading' — they are inside ``` code examples. lib/md-parse.mjs used to skip fenced blocks (``` and ~~~) when scanning for headings; a parser rewrite dropped that. lib/toc.mjs builds the list on top of parseHeadings. Fix the parser so fenced content is ignored again (TOC building, slug dedupe with -2/-3 and indenting must keep working) and verify with content/sample.md plus your own cases before answering.",
    {
      "lib/md-parse.mjs": `/**
 * Headings of a markdown document: lines like "## Title" outside fenced
 * code blocks. A fence opens at a line starting (after spaces) with three
 * or more backticks or tildes and closes at the next line starting with
 * the same marker; headings inside fences are not headings. ATX hashes
 * only, up to 6; trailing #'s are trimmed.
 */
export function parseHeadings(markdown) {
  const out = [];
  let fence = null;
  for (const line of String(markdown).split("\\n")) {
    const fenceMark = /^\\s*(\`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      if (fence === null) {
        fence = fenceMark[1][0];
      } else if (fenceMark[1][0] === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    const heading = /^(#{1,6})\\s+(.+?)\\s*#*\\s*$/.exec(line);
    if (heading) out.push({ level: heading[1].length, text: heading[2] });
  }
  return out;
}
`,
      "lib/toc.mjs": `import { parseHeadings } from "./md-parse.mjs";

/** GitHub-ish slug: lowercase, non-alphanumerics to '-', trimmed. */
export function slugifyHeading(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * TOC: one "- [title](#slug)" per heading, 2 spaces of indent per level-1,
 * duplicate slugs get -2, -3, ... in document order.
 */
export function buildToc(markdown) {
  const seen = new Map();
  const lines = [];
  for (const heading of parseHeadings(markdown)) {
    const base = slugifyHeading(heading.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const slug = n === 1 ? base : base + "-" + n;
    lines.push("  ".repeat(heading.level - 1) + "- [" + heading.text + "](#" + slug + ")");
  }
  return lines.join("\\n");
}
`,
      "content/sample.md": [
        "# Release Notes",
        "",
        "Intro paragraph.",
        "",
        "## Install",
        "",
        "```bash",
        "## this is NOT a heading",
        "npm install acpio",
        "```",
        "",
        "## Install",
        "",
        "Second note, the slug must dedupe.",
        "",
        "### Config",
        "",
        "~~~",
        "## also not a heading",
        "~~~",
        "",
        "#### Deep",
        "",
        "#Not a heading (no space)",
        "",
        "Regular text with # hash.",
        "",
      ].join("\n"),
    },
    {
      "lib/md-parse.mjs": [
        [
          "    const fenceMark = /^\\s*(`{3,}|~{3,})/.exec(line);",
          "    if (fenceMark) {",
          "      if (fence === null) {",
          "        fence = fenceMark[1][0];",
          "      } else if (fenceMark[1][0] === fence) {",
          "        fence = null;",
          "      }",
          "      continue;",
          "    }",
          "    if (fence !== null) continue;",
        ].join("\n"),
        "    // fence tracking was dropped in the parser rewrite (PROJ-914)",
      ],
    },
    `import { readFileSync } from "node:fs";
import { buildToc, slugifyHeading } from "./lib/toc.mjs";
import { parseHeadings } from "./lib/md-parse.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const md = readFileSync("content/sample.md", "utf8");
const expected = [
  "- [Release Notes](#release-notes)",
  "  - [Install](#install)",
  "  - [Install](#install-2)",
  "    - [Config](#config)",
  "      - [Deep](#deep)",
].join("\\n");
const toc = buildToc(md);
if (toc !== expected) fail("toc mismatch:\\n" + toc + "\\n--- expected ---\\n" + expected);
const headings = parseHeadings(md);
if (headings.length !== 5) fail("expected 5 headings, got " + headings.length + ": " + JSON.stringify(headings));
if (slugifyHeading("  Hello,  World! ") !== "hello-world") fail("slugifyHeading broken");
if (buildToc("") !== "") fail("empty document");
if (buildToc("# A\\n# A\\n# A").split("\\n")[2] !== "- [A](#a-3)") fail("third duplicate must get -3");

console.log("PASS: toc skips fenced code and dedupes slugs");
`,
  ),

  def(
    "medium",
    "sliding-window-limiter",
    "Rate limiter lets a burst through at every window boundary",
    "Upstream 429s spike periodically: the limiter refills its whole quota the moment the oldest hit ages out of the window, so clients double their rate right at the boundary. lib/limiter.mjs specifies a SLIDING window (at most `limit` calls in any windowMs stretch) with an injectable clock. Fix it and verify with your own script using a fake clock: full window blocks with retryAfterMs, boundary frees exactly the slots whose hits left, constructor validation.",
    {
      "lib/limiter.mjs": `/**
 * Sliding-window rate limiter: at most \`limit\` calls in ANY \`windowMs\`
 * stretch. When blocked, retryAfterMs says when the oldest hit leaves the
 * window. The clock is injectable.
 */
export function createLimiter({ limit, windowMs, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be positive");
  const hits = [];
  return {
    get size() { return hits.length; },
    allow() {
      const t = now();
      while (hits.length > 0 && t - hits[0] >= windowMs) hits.shift();
      if (hits.length < limit) {
        hits.push(t);
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: hits[0] + windowMs - t };
    },
  };
}
`,
    },
    {
      "lib/limiter.mjs": [
        "      while (hits.length > 0 && t - hits[0] >= windowMs) hits.shift();",
        "      if (hits.length > 0 && t - hits[0] >= windowMs) hits.length = 0; // fixed-window reset",
      ],
    },
    `import { createLimiter } from "./lib/limiter.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const limiter = createLimiter({ limit: 3, windowMs: 1000, now: () => t });

if (!limiter.allow().allowed) fail("empty window must allow");
if (limiter.size !== 1) fail("size must track recorded hits");
t = 900;
if (!limiter.allow().allowed) fail("second slot");
t = 950;
if (!limiter.allow().allowed) fail("third slot");
const full = limiter.allow();
if (full.allowed || full.retryAfterMs !== 50) fail("4th call must be blocked with retry in 50ms, got " + JSON.stringify(full));
t = 999;
if (limiter.allow().allowed) fail("still full at t=999");

t = 1000;
let allowedAtBoundary = 0;
while (limiter.allow().allowed) allowedAtBoundary++;
if (allowedAtBoundary !== 1) fail("at t=1000 exactly 1 slot frees (sliding window), allowed " + allowedAtBoundary);

t = 1500;
if (limiter.allow().allowed) fail("still saturated at t=1500");
t = 5000;
let allowedAfterQuiet = 0;
while (limiter.allow().allowed) allowedAfterQuiet++;
if (allowedAfterQuiet !== 3) fail("after a quiet stretch the full quota must be free, allowed " + allowedAfterQuiet);

let threw = false;
try { createLimiter({ limit: 0, windowMs: 100 }); } catch { threw = true; }
if (!threw) fail("limit must be a positive integer");
threw = false;
try { createLimiter({ limit: 2, windowMs: -1 }); } catch { threw = true; }
if (!threw) fail("windowMs must be positive");

console.log("PASS: the window slides — boundaries free only expired slots");
`,
  ),

  def(
    "medium",
    "csv-serialize",
    "Export breaks on the second quote inside a field",
    "The CSV export is importable again after one fix, except for values with MORE than one quote: a field like 'say \"hi\" now' comes back mangled on re-import. Per the RFC 4180 note in lib/csvw.mjs, EVERY quote inside a quoted field must be doubled. Fix lib/csvw.mjs and verify with your own script (quotes, commas, newlines, CR, null/undefined, numbers, multi-row, empty rows/fields) before answering.",
    {
      "lib/csvw.mjs": `/**
 * RFC 4180 writer. A field is quoted only when it contains a comma, a
 * double-quote, CR or LF; quotes inside are DOUBLED — every one of them.
 * Rows are joined with CRLF; null/undefined become empty fields.
 */
export function encodeCsv(rows) {
  return rows.map((row) => row.map(encodeField).join(",")).join("\\r\\n");
}

function encodeField(value) {
  const s = String(value ?? "");
  return /[",\\r\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
`,
    },
    {
      "lib/csvw.mjs": [
        "  return /[\",\\r\\n]/.test(s) ? '\"' + s.replace(/\"/g, '\"\"') + '\"' : s;",
        "  return /[\",\\r\\n]/.test(s) ? '\"' + s.replace('\"', '\"\"') + '\"' : s; // first quote only",
      ],
    },
    `import { encodeCsv } from "./lib/csvw.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  [[["a", "b", "c"]], "a,b,c"],
  [[["x,y"]], '"x,y"'],
  [[['say "hi" now']], '"say ""hi"" now"'],
  [[['a "b" and "c"']], '"a ""b"" and ""c"""'],
  [[["line1\\nline2"]], '"line1\\nline2"'],
  [[["cr\\rhere"]], '"cr\\rhere"'],
  [[[null, "", 42, true]], ",,42,true"],
  [[["a"], ["b"]], "a\\r\\nb"],
  [[["name", "note"], ["ada", 'wrote "code", daily']], "name,note\\r\\nada,\\"wrote \\"\\"code\\"\\", daily\\""],
  [[["a", "", "c"]], "a,,c"],
  [[[]], ""],
];
for (const [rows, expected] of cases) {
  const got = encodeCsv(rows);
  if (got !== expected) fail(JSON.stringify(rows) + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
}

console.log("PASS: every quote inside a quoted field is doubled");
`,
  ),
];
