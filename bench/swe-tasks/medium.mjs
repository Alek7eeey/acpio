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

  def(
    "medium",
    "min-heap",
    "Priority queue pops mid-range jobs before the urgent ones",
    "Run `node check.mjs`. The job runner orders work with lib/heap.mjs, and since a cleanup some pops come out of order: after pushing [5, 3, 8, 1, 9, 2] the queue handed back 8 while 5 was still queued. The header pins the contract — every pop returns the SMALLEST remaining value, so any full drain is ascending, whatever the push order. The likely culprit is the sift-down child selection. Fix lib/heap.mjs, re-run the check, and verify the rest with your own script (40-element drain in a scrambled push order, interleaved push/pop, duplicates, peek/size, pop on empty) before answering.",
    {
      "lib/heap.mjs": `/**
 * Binary min-heap of numbers. push/pop/peek/size; pop on an empty heap
 * returns undefined. Every pop returns the SMALLEST remaining value, so a
 * full drain is always ascending. Duplicates are fine.
 */
export class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  peek() {
    return this.items[0];
  }

  push(value) {
    this.items.push(value);
    this.siftUp(this.items.length - 1);
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  siftUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent] <= this.items[i]) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  siftDown(i) {
    const n = this.items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.items[left] < this.items[smallest]) smallest = left;
      if (right < n && this.items[right] < this.items[smallest]) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}
`,
      "check.mjs": `import { MinHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new MinHeap();
for (const n of [5, 3, 8, 1, 9, 2]) heap.push(n);
const drained = [];
while (heap.size > 0) drained.push(heap.pop());
if (drained.join(",") !== "1,2,3,5,8,9") fail("drain must be ascending, got " + drained.join(","));

console.log("PASS: the queue drains ascending");
`,
    },
    {
      "lib/heap.mjs": [
        [
          "      if (left < n && this.items[left] < this.items[smallest]) smallest = left;",
          "      if (right < n && this.items[right] < this.items[smallest]) smallest = right;",
        ].join("\n"),
        "      if (left < n && this.items[left] < this.items[smallest]) smallest = left;\n      // the left child is the smaller one after a clean push phase (PROD-4459)",
      ],
    },
    `import { MinHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let seed = 42;
const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);

const heap = new MinHeap();
const values = Array.from({ length: 40 }, () => next() % 100);
for (const v of values) heap.push(v);
const drained = [];
while (heap.size > 0) drained.push(heap.pop());
const expected = [...values].sort((a, b) => a - b);
if (drained.join(",") !== expected.join(",")) fail("full drain must be ascending: " + drained.join(","));

const h2 = new MinHeap();
h2.push(10);
h2.push(4);
if (h2.pop() !== 4) fail("interleaved pop 1");
h2.push(7);
h2.push(1);
if (h2.peek() !== 1 || h2.size !== 3) fail("peek/size after pushes");
if (h2.pop() !== 1) fail("interleaved pop 2");
if (h2.pop() !== 7) fail("interleaved pop 3");
if (h2.pop() !== 10) fail("interleaved pop 4");
if (h2.pop() !== undefined || h2.size !== 0) fail("pop on empty must be undefined");

const h3 = new MinHeap();
for (const v of [2, 2, 2]) h3.push(v);
if (h3.pop() !== 2 || h3.pop() !== 2 || h3.pop() !== 2) fail("duplicates must drain");

const h4 = new MinHeap();
h4.push(9);
if (h4.peek() !== 9 || h4.pop() !== 9) fail("single element");

console.log("PASS: pops always return the smallest remaining value");
`,
  ),

  def(
    "medium",
    "token-bucket",
    "Idle API clients burst far past their bucket capacity",
    "After a quiet night the first client burst hammers the API with hundreds of requests although the bucket capacity is 5: the refill accumulator grew all night and nothing capped it. Per the header of lib/bucket.mjs, refill NEVER tops the bucket above capacity — idle time buys one full bucket, not an endless reserve. The clock is injectable. Fix lib/bucket.mjs and verify with your own script using a fake clock (drain to empty, idle refill capped at capacity, partial refill with an honest retryAfterMs, constructor and take() validation) before answering.",
    {
      "lib/bucket.mjs": `/**
 * Token bucket: at most \`capacity\` tokens, refilled continuously at
 * \`refillPerSec\`. take(n) removes n tokens or reports retryAfterMs. The
 * refill NEVER tops the bucket above capacity — idle time buys one full
 * bucket, not an endless reserve. The clock is injectable (ms).
 */
export function createTokenBucket({ capacity, refillPerSec, now = Date.now.bind(Date) } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) throw new RangeError("refillPerSec must be positive");
  let tokens = capacity;
  let last = now();

  const refill = (t) => {
    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
    last = t;
  };

  return {
    get tokens() {
      return Math.min(capacity, tokens + ((now() - last) / 1000) * refillPerSec);
    },
    take(n = 1) {
      if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
      refill(now());
      if (tokens >= n) {
        tokens -= n;
        return { allowed: true, tokens };
      }
      const missing = n - tokens;
      return { allowed: false, retryAfterMs: Math.ceil((missing / refillPerSec) * 1000) };
    },
  };
}
`,
    },
    {
      "lib/bucket.mjs": [
        "    tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);",
        "    tokens = tokens + ((t - last) / 1000) * refillPerSec; // the bucket keeps every token it earns (PROD-4461)",
      ],
    },
    `import { createTokenBucket } from "./lib/bucket.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let t = 0;
const bucket = createTokenBucket({ capacity: 5, refillPerSec: 1, now: () => t });

for (let i = 0; i < 5; i++) {
  if (!bucket.take().allowed) fail("a fresh bucket must allow 5 takes, failed at " + i);
}
if (bucket.take().allowed) fail("an empty bucket must block");
const blocked = bucket.take(2);
if (blocked.allowed || blocked.retryAfterMs !== 2000) fail("retryAfterMs must cover 2 missing tokens: " + JSON.stringify(blocked));

t = 600_000; // ten idle minutes
if (bucket.tokens !== 5) fail("idle time must refill to capacity, not past it: " + bucket.tokens);
let granted = 0;
while (bucket.take().allowed) granted++;
if (granted !== 5) fail("after idle the bucket must grant exactly capacity tokens, granted " + granted);

t += 2500; // 2.5 tokens back
if (!bucket.take(2).allowed) fail("2 tokens must be available after 2.5s of refill");
const tight = bucket.take(2);
if (tight.allowed || tight.retryAfterMs !== 1500) fail("a half-refilled bucket must report the missing half second: " + JSON.stringify(tight));

for (const bad of [0, -1, 1.5]) {
  let threw = false;
  try { bucket.take(bad); } catch { threw = true; }
  if (!threw) fail("take(" + bad + ") must throw");
}
let threw = false;
try { createTokenBucket({ capacity: 0, refillPerSec: 1 }); } catch { threw = true; }
if (!threw) fail("capacity must be a positive integer");
threw = false;
try { createTokenBucket({ capacity: 5, refillPerSec: -1 }); } catch { threw = true; }
if (!threw) fail("refillPerSec must be positive");

console.log("PASS: refill caps at capacity; take reports honest retries");
`,
  ),

  def(
    "medium",
    "json-patch",
    "Moving a list item forward drops it one slot too far",
    "Run `node check.mjs`. In the board UI, dragging a card to slot N lands it one past the slot whenever it moves from an earlier to a later position — the reorder ops produced by the client use indexes that refer to the array BEFORE the move, and lib/patch.mjs must honor exactly that (its header says so). The move op removes the item first and then inserts; somewhere the removal adjustment is lost. Fix lib/patch.mjs, keep the other ops (add inserts into arrays, remove/replace throw on missing paths, move works across containers, the input doc is never mutated), re-run the check, and verify the rest with your own script.",
    {
      "lib/patch.mjs": `/**
 * Tiny JSON patch: applyPatch(doc, ops) with ops
 *   { op: "add", path, value }     — set on objects, INSERT on arrays
 *                                    ("-" or the length appends),
 *   { op: "remove", path }        — delete a key / splice an array index,
 *   { op: "replace", path, value } — overwrite; a missing path is an Error,
 *   { op: "move", from, path }     — remove + insert; BOTH indexes refer to
 *                                    the array BEFORE the move.
 * Paths are dot separated ("a.list.0"). The input doc is never mutated;
 * remove/replace/move on a missing path and unknown ops throw.
 */
export function applyPatch(doc, ops) {
  const out = deepClone(doc);
  for (const op of ops) applyOp(out, op);
  return out;
}

function applyOp(root, op) {
  if (op.op === "add") {
    const { parent, key } = resolve(root, op.path, true);
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error("bad array index: " + op.path);
      parent.splice(index, 0, deepClone(op.value));
      return;
    }
    parent[key] = deepClone(op.value);
    return;
  }

  if (op.op === "remove") {
    const { parent, key } = resolve(root, op.path, false);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error("bad array index: " + op.path);
      parent.splice(index, 1);
      return;
    }
    if (!(key in parent)) throw new Error("no such path: " + op.path);
    delete parent[key];
    return;
  }

  if (op.op === "replace") {
    const { parent, key } = resolve(root, op.path, false);
    if (Array.isArray(parent)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error("bad array index: " + op.path);
      parent[index] = deepClone(op.value);
      return;
    }
    if (!(key in parent)) throw new Error("no such path: " + op.path);
    parent[key] = deepClone(op.value);
    return;
  }

  if (op.op === "move") {
    const from = resolve(root, op.from, false);
    const fromIsArray = Array.isArray(from.parent);
    const fromIndex = fromIsArray ? Number(from.key) : -1;
    if (fromIsArray && (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= from.parent.length)) {
      throw new Error("bad array index: " + op.from);
    }
    if (!fromIsArray && !(from.key in from.parent)) throw new Error("no such path: " + op.from);
    const value = fromIsArray ? from.parent[fromIndex] : from.parent[from.key];

    const to = resolve(root, op.path, true);
    const toArray = Array.isArray(to.parent);
    const sameArray = fromIsArray && toArray && to.parent === from.parent;
    const toLength = toArray ? to.parent.length : -1; // length BEFORE the removal

    if (fromIsArray) from.parent.splice(fromIndex, 1);
    else delete from.parent[from.key];

    if (toArray) {
      const raw = to.key === "-" ? toLength : Number(to.key);
      if (!Number.isInteger(raw) || raw < 0 || raw > toLength) throw new Error("bad array index: " + op.path);
      const target = sameArray && fromIndex < raw ? raw - 1 : raw;
      to.parent.splice(target, 0, value);
      return;
    }
    to.parent[to.key] = value;
    return;
  }

  throw new Error("unknown op: " + op.op);
}

function resolve(root, path, create) {
  if (typeof path !== "string" || path === "") throw new Error("bad path: " + path);
  const segments = path.split(".");
  let parent = root;
  for (let i = 0; i < segments.length - 1; i++) {
    let next = parent[segments[i]];
    if (next === null || typeof next !== "object") {
      if (!create) throw new Error("no such path: " + path);
      next = /^\\d+$/.test(segments[i + 1]) ? [] : {};
      parent[segments[i]] = next;
    }
    parent = next;
  }
  return { parent, key: segments[segments.length - 1] };
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}
`,
      "check.mjs": `import { applyPatch } from "./lib/patch.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const board = applyPatch({ cards: ["one", "two", "three"] }, [{ op: "move", from: "cards.0", path: "cards.2" }]);
if (board.cards.join(",") !== "two,one,three") {
  fail("dragging card one onto slot three lost a card: " + board.cards.join(","));
}

console.log("PASS: a forward move lands on the requested slot");
`,
    },
    {
      "lib/patch.mjs": [
        "      const target = sameArray && fromIndex < raw ? raw - 1 : raw;",
        "      const target = raw; // the index already accounts for the removal (PROD-4468)",
      ],
    },
    `import { applyPatch } from "./lib/patch.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const doc = { user: { name: "Ada", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d"], keep: true };

if (!eq(applyPatch(doc, [{ op: "add", path: "user.email", value: "a@b.c" }]).user.email, "a@b.c")) fail("add object key");
if (!eq(applyPatch(doc, [{ op: "add", path: "list.0", value: "z" }]).list, ["z", "a", "b", "c", "d"])) fail("add must INSERT into arrays");
if (!eq(applyPatch(doc, [{ op: "add", path: "list.-", value: "end" }]).list, ["a", "b", "c", "d", "end"])) fail("add '-' must append");
if (!eq(applyPatch(doc, [{ op: "remove", path: "user.name" }]).user, { tags: ["x", "y", "z"] })) fail("remove object key");
if (!eq(applyPatch(doc, [{ op: "remove", path: "list.1" }]).list, ["a", "c", "d"])) fail("remove must splice arrays");
if (!eq(applyPatch(doc, [{ op: "replace", path: "list.2", value: "C" }]).list, ["a", "b", "C", "d"])) fail("replace array element");
if (!eq(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.2" }]).list, ["b", "a", "c", "d"])) {
  fail("a forward move must land at the index the original array named: " + JSON.stringify(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.2" }]).list));
}
if (!eq(applyPatch(doc, [{ op: "move", from: "list.3", path: "list.0" }]).list, ["d", "a", "b", "c"])) fail("move backward broken");
if (!eq(applyPatch(doc, [{ op: "move", from: "list.0", path: "list.-" }]).list, ["b", "c", "d", "a"])) fail("move to '-' must append");
if (!eq(applyPatch(doc, [{ op: "move", from: "user.tags.2", path: "user.tags.0" }]).user.tags, ["z", "x", "y"])) fail("nested move broken");
if (!eq(applyPatch({ a: 1, b: 2 }, [{ op: "move", from: "a", path: "c" }]), { b: 2, c: 1 })) fail("object move broken");
const cross = applyPatch({ src: [1, 2], dst: [] }, [{ op: "move", from: "src.0", path: "dst.-" }]);
if (!eq(cross.src, [2]) || !eq(cross.dst, [1])) fail("cross-container move broken");
if (!eq(applyPatch(doc, [
  { op: "replace", path: "user.name", value: "A." },
  { op: "add", path: "list.-", value: "e" },
]), { user: { name: "A.", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d", "e"], keep: true })) fail("multi-op sequence broken");

if (!eq(doc, { user: { name: "Ada", tags: ["x", "y", "z"] }, list: ["a", "b", "c", "d"], keep: true })) fail("input doc was mutated");

let threw = false;
try { applyPatch(doc, [{ op: "nope", path: "list.0" }]); } catch { threw = true; }
if (!threw) fail("unknown op must throw");
threw = false;
try { applyPatch(doc, [{ op: "replace", path: "ghost.path", value: 1 }]); } catch { threw = true; }
if (!threw) fail("replace on a missing path must throw");
threw = false;
try { applyPatch(doc, [{ op: "remove", path: "list.9" }]); } catch { threw = true; }
if (!threw) fail("remove past the end must throw");
threw = false;
try { applyPatch(doc, [{ op: "move", from: "list.0", path: "list.9" }]); } catch { threw = true; }
if (!threw) fail("move past the end must throw");

console.log("PASS: add/remove/replace/move behave, moves keep pre-move indexes");
`,
  ),

  def(
    "medium",
    "template-interpolate",
    "Two placeholders on one line break the notification renderer",
    "Notifications like Hi {{first}} {{last}}! started failing with 'missing key' although both keys exist. The placeholder regex in lib/interp.mjs was loosened and now spans from the first opening braces to the LAST closing ones, swallowing everything between two placeholders. The header documents each {{ }} pair as its own placeholder carrying an optional dot path; a missing key must throw an Error that NAMES the key. Fix lib/interp.mjs and verify with your own script (two placeholders on a line, the same placeholder twice, dot paths, numbers and false render, empty-string values, missing keys throw with the key name, braces that name no valid path stay literal) before answering.",
    {
      "lib/interp.mjs": `/**
 * Render "{{ path }}" placeholders from a dot path into the scope. Every
 * {{ }} pair is its own placeholder — one placeholder never swallows
 * another. Missing keys (undefined or null at any path step) throw an
 * Error naming the key. Values are stringified with String().
 */
const PLACEHOLDER = /\\{\\{\\s*([a-zA-Z0-9_.]+)\\s*\\}\\}/g;

export function render(template, scope) {
  if (scope === null || typeof scope !== "object") throw new TypeError("scope must be an object");
  return String(template).replace(PLACEHOLDER, (_, path) => {
    let value = scope;
    for (const segment of path.split(".")) {
      if (value === null || value === undefined) break;
      value = value[segment];
    }
    if (value === null || value === undefined) throw new Error("missing key: " + path);
    return String(value);
  });
}
`,
    },
    {
      "lib/interp.mjs": [
        "const PLACEHOLDER = /\\{\\{\\s*([a-zA-Z0-9_.]+)\\s*\\}\\}/g;",
        "const PLACEHOLDER = /\\{\\{(.*)\\}\\}/g; // placeholders are rare, greedy is fine (PROD-4470)",
      ],
    },
    `import { render } from "./lib/interp.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (render("Hi {{name}}!", { name: "Ada" }) !== "Hi Ada!") fail("single placeholder broken");
let out;
try {
  out = render("Hi {{first}} {{last}}!", { first: "Grace", last: "Hopper" });
} catch (err) {
  fail("two placeholders on a line must both resolve, threw: " + err.message);
}
if (out !== "Hi Grace Hopper!") fail("two placeholders broken: " + JSON.stringify(out));
if (render("{{a}} and {{a}}", { a: "x" }) !== "x and x") fail("a repeated placeholder must resolve twice");
if (render("{{user.name}} from {{user.city}}", { user: { name: "Bo", city: "Oslo" } }) !== "Bo from Oslo") fail("dot paths broken");
if (render("n={{count}} ok={{ok}}", { count: 0, ok: false }) !== "n=0 ok=false") fail("numbers and false must render");
if (render("{{tag}}", { tag: "" }) !== "") fail("empty-string values must render as empty");
if (render("no placeholders here", {}) !== "no placeholders here") fail("plain text broken");
if (render("code: {{a_b.c1}}", { a_b: { c1: 7 } }) !== "code: 7") fail("underscores and digits in paths broken");
if (render("{{ spaced }}", { spaced: 1 }) !== "1") fail("inner whitespace must be tolerated");

let threw = false;
try { render("{{missing.key}}", { missing: {} }); } catch (err) { threw = /missing\\.key/.test(err.message); }
if (!threw) fail("a missing key must throw naming the key");
threw = false;
try { render("{{nope}}", {}); } catch { threw = true; }
if (!threw) fail("an unknown key must throw");
threw = false;
try { render("x", null); } catch { threw = true; }
if (!threw) fail("scope must be an object");
if (render("{{a b}}", { a: 1 }) !== "{{a b}}") fail("braces that name no valid path must stay literal");

console.log("PASS: each {{ }} pair resolves on its own");
`,
  ),

  def(
    "medium",
    "playlist-remove",
    "Skipping backward after removing a track jumps to the void",
    "In the media player, removing a track and then pressing 'previous' stops playback: the backward chain is severed at every removal. lib/playlist.mjs is a doubly linked list and its header is explicit — removal must reconnect BOTH directions, and toArrayReversed() must always mirror toArray(). Fix lib/playlist.mjs and verify with your own script (remove head/middle/tail, forward and backward walks after each removal, removing the current track selects the next one, remove unknown returns false, drain to empty and reuse) before answering.",
    {
      "lib/playlist.mjs": `/**
 * Doubly linked playlist. next/prev walk in O(1). Removing a track must
 * reconnect BOTH directions — the neighbors' forward AND backward links —
 * so toArrayReversed() always mirrors toArray(). current is the selected
 * track; removing it selects the NEXT track (or the last one if it was the
 * tail, null when the list empties).
 */
export function createPlaylist() {
  let head = null;
  let tail = null;
  let current = null;
  let count = 0;

  function makeNode(track) {
    return { track, prev: null, next: null };
  }

  return {
    get size() { return count; },
    get current() { return current ? current.track : null; },

    append(track) {
      const node = makeNode(track);
      if (tail) {
        tail.next = node;
        node.prev = tail;
        tail = node;
      } else {
        head = tail = node;
      }
      if (!current) current = node;
      count++;
      return this;
    },

    next() {
      if (current && current.next) current = current.next;
      return this.current;
    },

    prev() {
      if (current && current.prev) current = current.prev;
      return this.current;
    },

    remove(track) {
      for (let node = head; node; node = node.next) {
        if (node.track !== track) continue;
        if (node.prev) node.prev.next = node.next;
        else head = node.next;
        if (node.next) node.next.prev = node.prev;
        else tail = node.prev;
        if (current === node) current = node.next ?? node.prev;
        count--;
        return true;
      }
      return false;
    },

    toArray() {
      const out = [];
      for (let node = head; node; node = node.next) out.push(node.track);
      return out;
    },

    toArrayReversed() {
      const out = [];
      for (let node = tail; node; node = node.prev) out.push(node.track);
      return out;
    },
  };
}
`,
    },
    {
      "lib/playlist.mjs": [
        [
          "        if (node.next) node.next.prev = node.prev;",
          "        else tail = node.prev;",
        ].join("\n"),
        "        // backward links get rebuilt on demand (PROD-4473)\n        if (node.next) node.next.prev = null;\n        else tail = node.prev;",
      ],
    },
    `import { createPlaylist } from "./lib/playlist.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const pl = createPlaylist();
pl.append("a").append("b").append("c").append("d");
if (pl.size !== 4 || pl.current !== "a") fail("append/current broken");
if (!eq(pl.toArray(), ["a", "b", "c", "d"]) || !eq(pl.toArrayReversed(), ["d", "c", "b", "a"])) fail("walks broken before any removal");
if (pl.next() !== "b" || pl.next() !== "c") fail("next walk broken");
if (pl.prev() !== "b" || pl.prev() !== "a") fail("prev walk broken");

if (!pl.remove("b")) fail("remove must find the track");
if (!eq(pl.toArray(), ["a", "c", "d"])) fail("forward chain broken after middle removal");
if (!eq(pl.toArrayReversed(), ["d", "c", "a"])) fail("backward chain severed by middle removal: " + JSON.stringify(pl.toArrayReversed()));
if (pl.next() !== "c") fail("next over the gap broken");
if (pl.prev() !== "a") fail("prev over the gap broken, got " + pl.prev());

if (!pl.remove("a")) fail("remove head");
if (!eq(pl.toArray(), ["c", "d"]) || !eq(pl.toArrayReversed(), ["d", "c"])) fail("head removal broken");
if (!pl.remove("d")) fail("remove tail");
if (!eq(pl.toArray(), ["c"]) || !eq(pl.toArrayReversed(), ["c"])) fail("tail removal broken");

if (pl.remove("ghost") !== false) fail("removing an unknown track must return false");
if (!pl.remove("c")) fail("remove last");
if (pl.size !== 0 || pl.current !== null || !eq(pl.toArray(), [])) fail("drain to empty broken");
pl.append("new");
if (pl.current !== "new" || !eq(pl.toArray(), ["new"])) fail("reuse after empty broken");

const sel = createPlaylist();
sel.append("1").append("2").append("3");
sel.next();
if (sel.current !== "2") fail("select second track");
if (!sel.remove("2")) fail("remove current");
if (sel.current !== "3") fail("removing the current track must select the next one");

console.log("PASS: removal reconnects both directions");
`,
  ),

  def(
    "medium",
    "next-business-day",
    "Deadline planner promises Saturday deliveries",
    "The order planner adds N business days to the promised date, but since a simplify-the-calendar change orders placed on Friday are promised for Saturday and support is drowning. lib/business.mjs documents the rule: Saturday and Sunday are not business days, addBusinessDays steps FORWARD one day at a time and counts only business days, so Friday + 1 lands on Monday; the input date itself is never returned. Fix lib/business.mjs and verify with your own script (Friday starts, starts already on a weekend, spans of several weeks, month and year rollovers, isBusinessDay, invalid input throws) before answering.",
    {
      "lib/business.mjs": `/**
 * Business-day math over UTC dates ("YYYY-MM-DD"). Saturday and Sunday are
 * not business days. addBusinessDays steps FORWARD one day at a time and
 * counts only business days, so Friday + 1 business day lands on Monday.
 * n must be a positive integer; the input date itself is never returned
 * (even when it is a business day).
 */
export function isBusinessDay(iso) {
  const day = new Date(iso + "T00:00:00Z").getUTCDay();
  if (Number.isNaN(day)) throw new TypeError("bad date: " + iso);
  return day !== 0 && day !== 6;
}

export function addBusinessDays(iso, n) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(iso)) throw new TypeError("bad date: " + iso);
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be a positive integer");
  const d = new Date(iso + "T00:00:00Z");
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
`,
    },
    {
      "lib/business.mjs": [
        "    if (day !== 0 && day !== 6) left--;",
        "    left--; // weekends count too, every day is a working day now (PROD-4475)",
      ],
    },
    `import { addBusinessDays, isBusinessDay } from "./lib/business.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (addBusinessDays("2026-01-02", 1) !== "2026-01-05") fail("Friday + 1 must be Monday, got " + addBusinessDays("2026-01-02", 1));
if (addBusinessDays("2026-01-02", 3) !== "2026-01-07") fail("Friday + 3 must be Wednesday");
if (addBusinessDays("2026-01-05", 5) !== "2026-01-12") fail("Monday + 5 must skip the weekend");
if (addBusinessDays("2026-01-03", 1) !== "2026-01-05") fail("a Saturday start must move to Monday");
if (addBusinessDays("2026-01-04", 1) !== "2026-01-05") fail("a Sunday start must move to Monday");
if (addBusinessDays("2026-01-01", 10) !== "2026-01-15") fail("ten business days broken: " + addBusinessDays("2026-01-01", 10));
if (addBusinessDays("2026-01-30", 1) !== "2026-02-02") fail("month rollover broken");
if (addBusinessDays("2026-12-31", 1) !== "2027-01-01") fail("year rollover broken");
if (addBusinessDays("2026-12-31", 2) !== "2027-01-04") fail("year rollover + 2 broken");

if (isBusinessDay("2026-01-02") !== true) fail("Friday is a business day");
if (isBusinessDay("2026-01-05") !== true) fail("Monday is a business day");
if (isBusinessDay("2026-01-03") !== false) fail("Saturday is not");
if (isBusinessDay("2026-01-04") !== false) fail("Sunday is not");

let threw = false;
try { isBusinessDay("2026-13-40"); } catch { threw = true; }
if (!threw) fail("an impossible date must throw");
threw = false;
try { addBusinessDays("01/02/2026", 1); } catch { threw = true; }
if (!threw) fail("a malformed date must throw");
threw = false;
try { addBusinessDays("2026-01-02", 0); } catch { threw = true; }
if (!threw) fail("n must be a positive integer");

console.log("PASS: business-day math skips weekends across rollovers");
`,
  ),

  def(
    "medium",
    "ini-parser",
    "Settings values are cut at the second equals sign",
    "Run `node check.mjs`. After the deploy-config migration, integration URLs and tokens that contain '=' load truncated: 'callback = https://hooks/x?top=1' arrives as 'https://hooks/x?top'. The parser spec in lib/ini.mjs says the value is everything after the FIRST '=' on the line. Fix lib/ini.mjs — sections, namespacing, comments and blank-line handling must keep working — re-run the check, and verify the rest with your own script (values with '=', CRLF files, comments with leading spaces, keys before any section, section names with spaces, lines without '=' throw).",
    {
      "lib/ini.mjs": `/**
 * INI-ish settings parser: "key = value" lines inside "[section]" blocks.
 * Keys are lowercased and namespaced "section.key"; keys before any section
 * land under "core.". The value is everything after the FIRST '=' (values
 * may contain '='), trimmed. Full-line comments ('#' or ';' at the start,
 * after optional spaces) and blank lines are skipped.
 */
export function parseIni(text) {
  const settings = {};
  let section = "core";
  for (const rawLine of String(text).split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\\[(.+)\\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) throw new Error("not an ini line: " + rawLine);
    const key = section + "." + line.slice(0, eq).trim().toLowerCase();
    settings[key] = line.slice(eq + 1).trim();
  }
  return settings;
}
`,
      "check.mjs": `import { readFileSync } from "node:fs";
import { parseIni } from "./lib/ini.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const settings = parseIni(readFileSync("deploy.ini", "utf8"));
if (settings["auth.token"] !== "abc=def") fail("token truncated: " + JSON.stringify(settings["auth.token"]));
if (settings["db.url"] !== "postgres://u:p@h/db?ssl=true&app=svc") fail("url truncated: " + JSON.stringify(settings["db.url"]));

console.log("PASS: values survive every '=' after the first");
`,
      "deploy.ini": [
        "# deploy settings",
        "name = demo",
        "",
        "[db]",
        "host = localhost",
        "port = 5432",
        "url = postgres://u:p@h/db?ssl=true&app=svc",
        "",
        "[ Auth ]",
        "; service credentials",
        "TOKEN = abc=def",
        "retries = 3",
        "",
      ].join("\n"),
    },
    {
      "lib/ini.mjs": [
        [
          "    const eq = line.indexOf(\"=\");",
          "    if (eq === -1) throw new Error(\"not an ini line: \" + rawLine);",
          "    const key = section + \".\" + line.slice(0, eq).trim().toLowerCase();",
          "    settings[key] = line.slice(eq + 1).trim();",
        ].join("\n"),
        [
          "    const parts = line.split(\"=\"); // '=' is a separator, everywhere in the line (PROD-4478)",
          "    if (parts.length < 2) throw new Error(\"not an ini line: \" + rawLine);",
          "    const key = section + \".\" + parts[0].trim().toLowerCase();",
          "    settings[key] = parts[1].trim();",
        ].join("\n"),
      ],
    },
    `import { readFileSync } from "node:fs";
import { parseIni } from "./lib/ini.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const settings = parseIni(readFileSync("deploy.ini", "utf8"));
if (settings["core.name"] !== "demo") fail("core section broken: " + JSON.stringify(settings["core.name"]));
if (settings["db.host"] !== "localhost" || settings["db.port"] !== "5432") fail("db section broken: " + JSON.stringify(settings));
if (settings["db.url"] !== "postgres://u:p@h/db?ssl=true&app=svc") fail("value with '=' truncated: " + JSON.stringify(settings["db.url"]));
if (settings["auth.token"] !== "abc=def") fail("token with '=' truncated: " + JSON.stringify(settings["auth.token"]));
if (settings["auth.retries"] !== "3") fail("plain value in the same section broken");

const crlf = parseIni("a = 1\\r\\n[sec]\\r\\nb = 2\\r\\n");
if (crlf["core.a"] !== "1" || crlf["sec.b"] !== "2") fail("CRLF files broken");

const inline = parseIni("  # note\\n\\t; also note\\n   key   =   spaced value  \\n");
if (inline["core.key"] !== "spaced value") fail("trimming broken: " + JSON.stringify(inline));

let threw = false;
try { parseIni("justtext"); } catch { threw = true; }
if (!threw) fail("a line without '=' must throw");

console.log("PASS: sections, comments and '='-carrying values all parse");
`,
  ),

  def(
    "medium",
    "booking-conflicts",
    "Back-to-back bookings are rejected as double-booked",
    "Since the cleanup change the room UI refuses a 11:00-12:00 booking right after a 10:00-11:00 one — it says the room is already taken. lib/conflicts.mjs documents bookings as half-open [startMin, endMin): a booking ending at 11:00 and one starting at 11:00 do NOT overlap. Fix lib/conflicts.mjs and verify with your own script (touching intervals both orders, real overlap, containment, identical bookings, firstConflict hit and miss, free slot) before answering.",
    {
      "lib/conflicts.mjs": `/**
 * Room bookings are half-open: [startMin, endMin). A booking ending at
 * 11:00 and a booking starting at 11:00 do NOT overlap — the room has a
 * zero-minute gap and can be turned around. Two bookings conflict iff each
 * starts strictly before the other ends. Minutes are integers from the
 * day start; inside one booking start < end.
 */
export function conflicts(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Index of the first booking in 'bookings' conflicting with 'candidate',
 * or -1 when the slot is free. */
export function firstConflict(bookings, candidate) {
  return bookings.findIndex((b) => conflicts(b, candidate));
}
`,
    },
    {
      "lib/conflicts.mjs": [
        "  return a.start < b.end && b.start < a.end;",
        "  return a.start <= b.end && b.start < a.end; // back-to-back bookings left cleaning gaps (PROD-4517)",
      ],
    },
    `import { conflicts, firstConflict } from "./lib/conflicts.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const morning = { start: 600, end: 660 }; // 10:00-11:00
const noon = { start: 660, end: 720 }; // 11:00-12:00
if (conflicts(morning, noon)) fail("touching bookings do not conflict (a,b)");
if (conflicts(noon, morning)) fail("touching bookings do not conflict (b,a)");
if (!conflicts(morning, { start: 650, end: 700 })) fail("real overlap must conflict");
if (!conflicts(morning, { start: 645, end: 655 })) fail("containment must conflict");
if (!conflicts(morning, { start: 600, end: 660 })) fail("identical bookings conflict");
if (firstConflict([noon], morning) !== -1) fail("free slot reports -1");
if (firstConflict([noon, morning], { start: 620, end: 650 }) !== 1) fail("first conflicting index");
if (firstConflict([], morning) !== -1) fail("empty list is free");

console.log("PASS: half-open bookings touch without conflicting");
`,
  ),

  def(
    "medium",
    "utc-day-boundary",
    "Late-night events land in the wrong daily bucket",
    "Since the pipeline change, an event that happened at 23:59 UTC but was processed after midnight shows up in the NEW day's report, and replays rewrite history: the same event moves between buckets depending on when the worker got to it. lib/daykey.mjs documents the rule — bucket by the EVENT's own timestamp, in UTC, never by arrival. Fix lib/daykey.mjs and verify with your own script (late event lands on its event day, day boundary 23:59:59.999 vs 00:00:00, sums per day accumulate, empty input, receivedAt after midnight) before answering.",
    {
      "lib/daykey.mjs": `/**
 * Daily rollups bucket by the EVENT's own timestamp, in UTC — never by
 * when the event arrived. dayKey returns the "YYYY-MM-DD" UTC calendar day
 * of a millisecond timestamp; rollupByDay sums event.value per day.
 * A late event from 23:59 belongs to yesterday even if it is processed
 * after midnight, and replays never move it.
 */
export function dayKey(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function rollupByDay(events) {
  const days = new Map();
  for (const ev of events) {
    const key = dayKey(ev.ts);
    days.set(key, (days.get(key) ?? 0) + ev.value);
  }
  return days;
}
`,
    },
    {
      "lib/daykey.mjs": [
        "    const key = dayKey(ev.ts);",
        "    const key = dayKey(ev.receivedAt); // bucket by when we actually saw it (PROD-4518)",
      ],
    },
    `import { dayKey, rollupByDay } from "./lib/daykey.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86_400_000;

const lateNight = 1_790_000_000_000; // some 23:59:59.990 UTC
const justBeforeMidnight = Math.floor(lateNight / DAY) * DAY + DAY - 10;
const afterMidnight = Math.floor(lateNight / DAY) * DAY + DAY + 10;
if (dayKey(justBeforeMidnight) !== dayKey(justBeforeMidnight)) fail("sanity");
if (dayKey(justBeforeMidnight) === dayKey(afterMidnight)) fail("the day must turn at the UTC boundary");
if (dayKey(86_399_999) !== "1970-01-01") fail("last ms of day one");
if (dayKey(86_400_000) !== "1970-01-02") fail("first ms of day two");

const events = [
  { ts: justBeforeMidnight, receivedAt: afterMidnight, value: 5 },
  { ts: afterMidnight, receivedAt: afterMidnight + 5, value: 7 },
  { ts: justBeforeMidnight - 1, receivedAt: afterMidnight + 6, value: 3 },
];
const days = rollupByDay(events);
const yesterday = dayKey(justBeforeMidnight);
const today = dayKey(afterMidnight);
if (days.get(yesterday) !== 8) fail("both late-night events stay on their event day: " + days.get(yesterday));
if (days.get(today) !== 7) fail("the after-midnight event sums into its own day");
if (days.size !== 2) fail("exactly two buckets");
if (rollupByDay([]).size !== 0) fail("empty input");

console.log("PASS: buckets follow the event timestamp, arrival time is irrelevant");
`,
  ),

  def(
    "medium",
    "ring-buffer",
    "After wrap-around the sensor buffer returns the newest sample as the oldest",
    "The sensor history endpoint shows garbage after the buffer wraps: the newest reading shows up as the OLDEST entry in the timeline. lib/ring.mjs is a fixed-capacity FIFO ring with O(1) push documented to evict the OLDEST entry when full; contents() lists oldest -> newest. Fix lib/ring.mjs and verify with your own script (fill exactly, single wrap, several wraps, capacity one, size, contents returns a copy, constructor validation) before answering.",
    {
      "lib/ring.mjs": `/**
 * Fixed-capacity FIFO ring buffer with O(1) push. When full, a push
 * evicts the OLDEST entry; contents() lists oldest -> newest and returns
 * a fresh array every call.
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
    this.slots = new Array(capacity);
    this.head = 0; // index of the oldest entry
    this.count = 0;
  }

  push(value) {
    if (this.count < this.capacity) {
      this.slots[(this.head + this.count) % this.capacity] = value;
      this.count++;
    } else {
      this.slots[this.head] = value;
      this.head = (this.head + 1) % this.capacity;
    }
    return this;
  }

  contents() {
    const out = [];
    for (let i = 0; i < this.count; i++) out.push(this.slots[(this.head + i) % this.capacity]);
    return out;
  }

  get size() {
    return this.count;
  }
}
`,
    },
    {
      "lib/ring.mjs": [
        "      this.slots[this.head] = value;\n      this.head = (this.head + 1) % this.capacity;",
        "      this.slots[(this.head + this.count) % this.capacity] = value; // reuse the tail slot in place, indices never move (PROD-4519)",
      ],
    },
    `import { RingBuffer } from "./lib/ring.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const rb = new RingBuffer(3);
rb.push("a").push("b").push("c");
if (!eq(rb.contents(), ["a", "b", "c"])) fail("fill order: " + JSON.stringify(rb.contents()));
rb.push("d");
if (!eq(rb.contents(), ["b", "c", "d"])) fail("one wrap evicts the oldest: " + JSON.stringify(rb.contents()));
rb.push("e").push("f");
if (!eq(rb.contents(), ["d", "e", "f"])) fail("two wraps: " + JSON.stringify(rb.contents()));
if (rb.size !== 3) fail("size stays at capacity");

const one = new RingBuffer(1);
one.push("x").push("y");
if (!eq(one.contents(), ["y"])) fail("capacity one keeps the newest");

const snap = rb.contents();
snap.push("junk");
if (rb.contents().length !== 3) fail("contents returns a copy");

throws(() => new RingBuffer(0), "zero capacity");
throws(() => new RingBuffer(2.5), "fractional capacity");

console.log("PASS: wrap-around evicts the oldest, the timeline stays in order");
`,
  ),

  def(
    "medium",
    "matrix-rotate",
    "Sprite atlases come out of the rotator flipped",
    "The image tool's 90-degree rotation produces a mirrored result — the sprites land counter-clockwise. It slipped through review because the test atlas was symmetric. lib/rotate.mjs documents a CLOCKWISE rotation into a new matrix, correct for non-square inputs, input never mutated. Fix lib/rotate.mjs and verify with your own script (2x3 rectangle, non-symmetric square, single row, single column, 1x1, input not mutated) before answering.",
    {
      "lib/rotate.mjs": `/**
 * Rotate a matrix 90 degrees CLOCKWISE into a new matrix. A rows x cols
 * input becomes cols x rows — never assume a square. The input matrix is
 * not mutated. The first column of the result is the last row of the
 * input read bottom-up.
 */
export function rotate90(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const out = [];
  for (let c = 0; c < cols; c++) {
    const row = [];
    for (let r = rows - 1; r >= 0; r--) row.push(matrix[r][c]);
    out.push(row);
  }
  return out;
}
`,
    },
    {
      "lib/rotate.mjs": [
        "    for (let r = rows - 1; r >= 0; r--) row.push(matrix[r][c]);",
        "    for (let r = 0; r < rows; r++) row.push(matrix[r][c]); // storage order, fewer cache misses (PROD-4520)",
      ],
    },
    `import { rotate90 } from "./lib/rotate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const wide = [
  [1, 2, 3],
  [4, 5, 6],
];
const wideRotated = rotate90(wide);
if (!eq(wideRotated, [[4, 1], [5, 2], [6, 3]])) fail("2x3 rotates to 3x2: " + JSON.stringify(wideRotated));
if (!eq(wide, [[1, 2, 3], [4, 5, 6]])) fail("the input must not be mutated");

if (!eq(rotate90([[1, 2], [3, 4]]), [[3, 1], [4, 2]])) fail("non-symmetric square");
if (!eq(rotate90([[7]]), [[7]])) fail("1x1");
if (!eq(rotate90([[1, 2, 3]]), [[1], [2], [3]])) fail("single row becomes a column");
if (!eq(rotate90([[1], [2], [3]]), [[3, 2, 1]])) fail("single column becomes a row");

console.log("PASS: clockwise rotation, rectangles included, input untouched");
`,
  ),

  def(
    "medium",
    "event-time-buckets",
    "Events from the first half of every bucket land in the previous one",
    "Since the metrics cleanup, dashboards show events at :35 landing in the :30 bucket of the PREVIOUS hour window — an event at 10:35 with 10-minute buckets must be in the 10:30 bucket but shows in 11:00's... in short, half the events drift one bucket to the right. lib/buckets.mjs documents tumbling buckets: an event belongs to the bucket CONTAINING its own timestamp, bucketStart = floor(ts / bucketMs) * bucketMs, end exclusive. Fix lib/buckets.mjs and verify with your own script (event just inside a bucket, at the boundary, exact midpoint, sums with out-of-order events, empty input) before answering.",
    {
      "lib/buckets.mjs": `/**
 * Tumbling time buckets. An event belongs to the bucket CONTAINING its
 * own timestamp: bucketStart = floor(ts / bucketMs) * bucketMs. Arrival
 * order and arrival time are irrelevant — a late event lands in its own
 * bucket. The bucket end is exclusive: [start, start + bucketMs).
 */
export function bucketStart(tsMs, bucketMs) {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

/** Map bucketStart -> sum of event.value for events in that bucket. */
export function sumByBucket(events, bucketMs) {
  const sums = new Map();
  for (const ev of events) {
    const start = bucketStart(ev.ts, bucketMs);
    sums.set(start, (sums.get(start) ?? 0) + ev.value);
  }
  return sums;
}
`,
    },
    {
      "lib/buckets.mjs": [
        "  return Math.floor(tsMs / bucketMs) * bucketMs;",
        "  return Math.round(tsMs / bucketMs) * bucketMs; // round to the nearest bucket, sparse streams look fuller (PROD-4521)",
      ],
    },
    `import { bucketStart, sumByBucket } from "./lib/buckets.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MIN = 60_000;

if (bucketStart(35_000, MIN) !== 0) fail("35s belongs to the bucket that contains it");
if (bucketStart(59_999, MIN) !== 0) fail("59.999s is still bucket zero");
if (bucketStart(60_000, MIN) !== MIN) fail("the next bucket starts exactly at the boundary");
if (bucketStart(30_000, MIN) !== 0) fail("the exact midpoint is inside bucket zero");
if (bucketStart(0, MIN) !== 0) fail("epoch");

const sums = sumByBucket(
  [
    { ts: 35_000, value: 1 },
    { ts: 95_000, value: 2 },
    { ts: 20_000, value: 4 }, // out of arrival order
    { ts: 59_999, value: 8 },
  ],
  MIN,
);
if (!eq([...sums.entries()], [[0, 13], [MIN, 2]])) fail("sums per bucket: " + JSON.stringify([...sums.entries()]));
if (sumByBucket([], MIN).size !== 0) fail("empty input");

console.log("PASS: tumbling buckets contain their own events, floor not round");
`,
  ),

  def(
    "medium",
    "queue-fairness",
    "A burst on one queue starves the other",
    "The background queue waits behind entire interactive bursts: users watch exports start only after the last click finished. lib/scheduler.mjs documents the contract: with both queues non-empty the drain INTERLEAVES — one task from each in turn, oldest first within a queue; when one side empties, the rest of the other drains in order. Fix lib/scheduler.mjs and verify with your own script (strict alternation, tail drain, only-A, only-B, alternating then one side empties, both empty) before answering.",
    {
      "lib/scheduler.mjs": `/**
 * Two-queue work scheduler. drain(fn) walks both queues, calling fn(task,
 * side) per task and collecting the results in drain order. With both
 * queues non-empty it INTERLEAVES: one task from each in turn, starting
 * with A, oldest first within a queue — a burst on one side may not
 * starve the other. Once one queue runs dry the rest of the other drains
 * in order.
 */
export class TwoQueueScheduler {
  constructor() {
    this.a = [];
    this.b = [];
  }

  pushA(task) {
    this.a.push(task);
    return this;
  }

  pushB(task) {
    this.b.push(task);
    return this;
  }

  drain(fn) {
    const out = [];
    let ia = 0;
    let ib = 0;
    let turn = 0; // even -> A's turn, odd -> B's
    while (ia < this.a.length || ib < this.b.length) {
      let fromA;
      if (ia >= this.a.length) fromA = false;
      else if (ib >= this.b.length) fromA = true;
      else fromA = turn % 2 === 0;
      const task = fromA ? this.a[ia++] : this.b[ib++];
      out.push(fn(task, fromA ? "A" : "B"));
      turn++;
    }
    return out;
  }
}
`,
    },
    {
      "lib/scheduler.mjs": [
        "      let fromA;\n      if (ia >= this.a.length) fromA = false;\n      else if (ib >= this.b.length) fromA = true;\n      else fromA = turn % 2 === 0;",
        "      const fromA = ia < this.a.length; // drain one side fully, fewer switches, better locality (PROD-4522)",
      ],
    },
    `import { TwoQueueScheduler } from "./lib/scheduler.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const s = new TwoQueueScheduler();
s.pushA("a1").pushA("a2").pushA("a3").pushB("b1").pushB("b2");
const order = s.drain((task, side) => side + ":" + task);
if (!eq(order, ["A:a1", "B:b1", "A:a2", "B:b2", "A:a3"])) {
  fail("both queues must interleave: " + JSON.stringify(order));
}

const onlyA = new TwoQueueScheduler().pushA("x").pushA("y");
if (!eq(onlyA.drain((t) => t), ["x", "y"])) fail("single side drains in order");

const tail = new TwoQueueScheduler().pushA("a").pushB("b1").pushB("b2").pushB("b3");
if (!eq(tail.drain((t) => t), ["a", "b1", "b2", "b3"])) fail("after A runs dry B drains in order");

const empty = new TwoQueueScheduler();
if (!eq(empty.drain(() => 1), [])) fail("both empty drains nothing");

console.log("PASS: the scheduler alternates between queues, no starvation");
`,
  ),

  def(
    "medium",
    "flag-defaults",
    "The five-percent rollout is serving everyone",
    "After the flag-platform cleanup, a flag with a rollout-rule default is ON for every user, not the intended five percent. Two modules: lib/store.mjs keeps definitions whose 'default' may be a plain value or a ROLLOUT RULE — a function called with the user context that returns the value for that user; lib/evaluate.mjs resolves user > env > default and documents that a function default must be CALLED with the context. Fix the broken module and verify with your own script (plain default, rollout rule true and false across users, user override beats rollout, env beats default, unknown flag false) before answering.",
    {
      "lib/store.mjs": `/**
 * Flag definitions: id -> { id, default, description }. 'default' is
 * either a plain value or a ROLLOUT RULE: a function called with the user
 * context that returns the flag value for that user (e.g. a gate on a
 * percentage of users).
 */
export function flagStore(defs) {
  const byId = new Map(defs.map((d) => [d.id, Object.freeze({ ...d })]));
  return {
    has: (id) => byId.has(id),
    definition: (id) => byId.get(id),
  };
}
`,
      "lib/evaluate.mjs": `/**
 * Resolve one flag for one user: the user's override wins, then the
 * environment override, then the definition's default; an unknown flag is
 * false. A function default is a rollout rule — CALL it with the context
 * and use its return value, never the function itself.
 */
export function evaluate(store, id, ctx = {}) {
  const { user = {}, env = {} } = ctx;
  if (id in user) return user[id];
  if (id in env) return env[id];
  if (!store.has(id)) return false;
  const value = store.definition(id).default;
  return typeof value === "function" ? value(ctx) : value;
}
`,
    },
    {
      "lib/evaluate.mjs": [
        '  return typeof value === "function" ? value(ctx) : value;',
        '  return typeof value === "function" ? true : value; // a rollout gate means the flag is on, keep the wiring simple (PROD-4523)',
      ],
    },
    `import { flagStore } from "./lib/store.mjs";
import { evaluate } from "./lib/evaluate.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const rollout = (ctx) => (ctx.user.id % 4 === 0 ? true : false); // every fourth user
const store = flagStore([
  { id: "static-on", default: true },
  { id: "static-off", default: false },
  { id: "beta", default: rollout },
]);

if (evaluate(store, "static-on", { user: { id: 1 } }) !== true) fail("plain true default");
if (evaluate(store, "static-off", { user: { id: 1 } }) !== false) fail("plain false default");
if (evaluate(store, "beta", { user: { id: 4 } }) !== true) fail("rollout admits user 4");
if (evaluate(store, "beta", { user: { id: 5 } }) !== false) fail("rollout keeps user 5 out: got " + evaluate(store, "beta", { user: { id: 5 } }));
if (evaluate(store, "beta", { user: { id: 5, beta: true } }) !== true) fail("user override beats the rollout");
if (evaluate(store, "static-off", { user: { id: 1 }, env: { "static-off": true } }) !== true) fail("env beats the default");
if (evaluate(store, "nope", { user: { id: 1 } }) !== false) fail("unknown flag is false");

console.log("PASS: rollout rules are called with the context, overrides win");
`,
  ),
];
