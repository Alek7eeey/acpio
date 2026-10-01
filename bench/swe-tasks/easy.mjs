// swe-* tasks, easy band: one file, one root cause, a plainly observable
// symptom. Every task must pass the generator's rule: the verifier FAILS on
// the planted bug and PASSES on the fixed sources.
import { def } from "./support.mjs";

export default [
  def(
    "easy",
    "debounce-timer",
    "Search-as-you-type fires the backend once per keystroke",
    "Run a few lines against lib/debounce.mjs: typing \"abc\" (three calls in quick succession) hits the backend three times instead of once. Debounce must collapse a burst into a single invocation `wait` ms after the LAST call, with the last call's arguments. Fix lib/debounce.mjs without changing its interface and verify with your own script before answering.",
    {
      "lib/debounce.mjs": `/**
 * Debounce: collapse a burst of calls into ONE invocation of \`fn\`, run
 * \`wait\` ms after the LAST call. The last call's arguments win; earlier
 * pending invocations are cancelled, not queued.
 */
export function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** Small helper the UI layer uses alongside debounce. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
`,
    },
    {
      "lib/debounce.mjs": [
        "    if (timer) clearTimeout(timer);",
        "    // pending runs are no longer cancelled (PROD-4171)",
      ],
    },
    `import { debounce, sleep } from "./lib/debounce.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const calls = [];
const run = debounce((label) => calls.push(label), 60);

run("a");
await sleep(15);
run("b");
await sleep(15);
run("c");
if (calls.length !== 0) fail("debounced fn fired before the wait elapsed: " + JSON.stringify(calls));
await sleep(150);
if (calls.length !== 1) fail("expected exactly 1 invocation, got " + calls.length + ": " + JSON.stringify(calls));
if (calls[0] !== "c") fail("last call's arguments must win, got " + calls[0]);

const second = [];
const run2 = debounce((x) => second.push(x), 20);
run2(1);
await sleep(80);
run2(2);
await sleep(80);
if (second.join(",") !== "1,2") fail("separated bursts must each run once: " + second.join(","));

console.log("PASS: debounce collapses bursts into the last call");
`,
  ),

  def(
    "easy",
    "throttle-trailing",
    "Throttle drops the final resize call, leaving the layout stale",
    "The editor throttles relayout on resize, but after a resize burst the panel keeps the pre-burst size: the call that arrived while the window was closed never runs. Fix lib/throttle.mjs: the first call of a window runs immediately (leading), and the last call that arrived during a closed window must run when it reopens (trailing). Do not change the public interface. Verify with your own script before answering.",
    {
      "lib/throttle.mjs": `/**
 * Throttle: at most one \`fn\` run per \`window\` ms. The first call of a window
 * runs immediately (leading); if more calls arrive while the window is
 * closed, the LAST of them runs when the window opens again (trailing), so
 * the final state is never lost.
 */
export function throttle(fn, window) {
  let readyAt = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    const remaining = readyAt - Date.now();
    if (remaining <= 0) {
      readyAt = Date.now() + window;
      fn(...args);
    } else {
      pending = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          const run = pending;
          pending = null;
          readyAt = Date.now() + window;
          fn(...run);
        }, remaining);
      }
    }
  };
}
`,
    },
    {
      "lib/throttle.mjs": [
        [
          "      pending = args;",
          "      if (!timer) {",
          "        timer = setTimeout(() => {",
          "          timer = null;",
          "          const run = pending;",
          "          pending = null;",
          "          readyAt = Date.now() + window;",
          "          fn(...run);",
          "        }, remaining);",
          "      }",
        ].join("\n"),
        "      pending = args; // trailing run was dropped in the rework (PROD-4187)",
      ],
    },
    `import { throttle } from "./lib/throttle.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seq = [];
const tick = throttle((label) => seq.push(label), 50);

tick("lead");
if (seq.join(",") !== "lead") fail("first call must run immediately: " + JSON.stringify(seq));
tick("a");
await sleep(10);
tick("b");
if (seq.join(",") !== "lead") fail("calls inside the window must not run yet: " + JSON.stringify(seq));
await sleep(80);
if (seq.join(",") !== "lead,b") fail("trailing call with the last arguments must run when the window reopens: " + JSON.stringify(seq));
await sleep(150);
tick("next");
if (seq.join(",") !== "lead,b,next") fail("a call after the window must run immediately: " + JSON.stringify(seq));
await sleep(100);

console.log("PASS: throttle runs leading immediately and keeps the trailing call");
`,
  ),

  def(
    "easy",
    "slugify",
    "Generated URLs contain double dashes and stray dashes",
    "CMS-generated links look like /blog/cafe--ubersicht---2026 and break routing matches. The slugger is supposed to fold diacritics (é → e), lowercase, collapse every run of non-alphanumerics into a single '-' and trim dashes at both ends. Fix lib/slug.mjs and verify with your own script (try multiple spaces, dashes, punctuation, accented input, empty string) before answering.",
    {
      "lib/slug.mjs": `/**
 * URL slugs: lowercase, fold diacritics (é → e), reduce every run of
 * non-alphanumerics to a single '-', trim '-' from both ends.
 */
export function slugify(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`,
    },
    {
      "lib/slug.mjs": [
        '    .replace(/[^a-z0-9]+/g, "-")',
        '    .replace(/[^a-z0-9]/g, "-")',
      ],
    },
    `import { slugify } from "./lib/slug.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["Café Übersicht — 2026!", "cafe-ubersicht-2026"],
  ["Hello   World", "hello-world"],
  ["  trim me  ", "trim-me"],
  ["A--B___C", "a-b-c"],
  ["already-fine", "already-fine"],
  ["!!!", ""],
  ["", ""],
];
for (const [input, expected] of cases) {
  const got = slugify(input);
  if (got !== expected) fail(JSON.stringify(input) + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
}

console.log("PASS: slugs fold diacritics and collapse separators");
`,
  ),

  def(
    "easy",
    "num-utils",
    "Volume slider and zoom extrapolate past their ends",
    "Two reports from the shared math helpers: a volume slider at t=-0.2 renders negative gain, and a zoom control at t=1.4 overshoots max zoom. The contract of lerp in lib/num.mjs says t is clamped to [0, 1] — no extrapolation — but the clamping is gone. Fix it there without changing any interface, and verify with your own script (clamp, lerp at both ends and beyond, roundTo including halves below zero) before answering.",
    {
      "lib/num.mjs": `/** Clamp x into [lo, hi]; swapped bounds are normalized. */
export function clamp(x, lo, hi) {
  if (lo > hi) [lo, hi] = [hi, lo];
  return Math.min(hi, Math.max(lo, x));
}

/** Interpolate lo..hi at t (t=0 -> lo, t=1 -> hi). t outside [0, 1] is
 * clamped: the helpers never extrapolate. */
export function lerp(lo, hi, t) {
  return lo + (hi - lo) * clamp(t, 0, 1);
}

/** Round half away from zero to \`digits\` decimals (2.5 -> 3, -2.5 -> -3). */
export function roundTo(x, digits = 0) {
  const f = 10 ** digits;
  return (x < 0 ? -Math.round(-x * f) : Math.round(x * f)) / f;
}
`,
    },
    {
      "lib/num.mjs": [
        "  return lo + (hi - lo) * clamp(t, 0, 1);",
        "  return lo + (hi - lo) * t;",
      ],
    },
    `import { clamp, lerp, roundTo } from "./lib/num.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (clamp(5, 0, 10) !== 5) fail("clamp in-range");
if (clamp(-3, 0, 10) !== 0) fail("clamp low");
if (clamp(42, 0, 10) !== 10) fail("clamp high");
if (clamp(5, 10, 0) !== 5) fail("clamp must normalize swapped bounds");

if (lerp(0, 10, 0.25) !== 2.5) fail("lerp mid");
if (lerp(10, 20, 0.5) !== 15) fail("lerp offset range");
if (lerp(0, 10, -0.5) !== 0) fail("lerp must clamp t < 0, got " + lerp(0, 10, -0.5));
if (lerp(0, 10, 1.5) !== 10) fail("lerp must clamp t > 1, got " + lerp(0, 10, 1.5));
if (lerp(3, 3, 0.7) !== 3) fail("lerp degenerate range");

if (roundTo(2.5) !== 3) fail("roundTo half up");
if (roundTo(-2.5) !== -3) fail("roundTo half away from zero, got " + roundTo(-2.5));
if (roundTo(1.2345, 2) !== 1.23) fail("roundTo digits, got " + roundTo(1.2345, 2));
if (roundTo(9.127, 1) !== 9.1) fail("roundTo one digit");

console.log("PASS: clamp/lerp/roundTo behave at the edges");
`,
  ),

  def(
    "easy",
    "history-undo",
    "Redo resurrects state that the user overwrote",
    "Users of the editor: undo, type something new, press redo — the panel jumps back to the discarded pre-edit state. The rule is the classic one: committing a new value clears the redo branch, because after an edit there is nothing to redo. Fix lib/history.mjs and verify with your own script (commit/undo/commit/redo, walking to both ends, no-op undo/redo) before answering.",
    {
      "lib/history.mjs": `/**
 * Undo/redo history. \`commit\` records a new present — and MUST discard the
 * redo branch: after an edit, there is nothing to redo. undo/redo at the
 * ends are no-ops that return the current value.
 */
export function createHistory(initial) {
  const past = [];
  let present = initial;
  const future = [];

  return {
    get() { return present; },
    commit(next) {
      past.push(present);
      present = next;
      future.length = 0;
    },
    undo() {
      if (past.length === 0) return present;
      future.push(present);
      present = past.pop();
      return present;
    },
    redo() {
      if (future.length === 0) return present;
      past.push(present);
      present = future.pop();
      return present;
    },
    canUndo() { return past.length > 0; },
    canRedo() { return future.length > 0; },
  };
}
`,
    },
    {
      "lib/history.mjs": [
        "      future.length = 0;",
        "      // redo branch survives edits (PROD-4166)",
      ],
    },
    `import { createHistory } from "./lib/history.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const h = createHistory("v0");
h.commit("v1");
h.commit("v2");
if (h.get() !== "v2" || !h.canUndo() || h.canRedo()) fail("baseline broken");
if (h.undo() !== "v1") fail("undo broken");
h.commit("v3");
if (h.canRedo()) fail("commit must clear the redo branch");
if (h.redo() !== "v3") fail("redo after an edit must be a no-op, got " + h.redo());
if (h.get() !== "v3") fail("redo after an edit must keep the edited present");

if (h.undo() !== "v1") fail("undo chain broken");
if (h.redo() !== "v3") fail("redo chain broken");
if (h.undo() !== "v1" || h.undo() !== "v0") fail("undo to bottom broken");
if (h.undo() !== "v0" || !h.canRedo()) fail("undo at the bottom must be a no-op");
if (h.redo() !== "v1") fail("redo after bottom no-op broken");

console.log("PASS: commit clears redo, undo/redo walk the chain");
`,
  ),

  def(
    "easy",
    "format-bytes",
    "Upload dialog shows a 50 MB file as 52.4 MB",
    "The storage page switched to showing decimal-looking numbers: a 50 MiB upload renders as 52.4 MB and a 3 GiB archive as 3.2 GB. Our formatter is specified in IEC binary units (1 KB = 1024 B) — see the header of lib/bytes.mjs. Somewhere on the way to that output the divisor is wrong. Fix lib/bytes.mjs and verify with your own script (sub-KB values, exact 1024, MB/GB/TB, invalid inputs throw) before answering.",
    {
      "lib/bytes.mjs": `/**
 * Human-readable byte sizes in IEC binary units: 1 KB = 1024 B. Values
 * under 1024 stay in bytes (integer); bigger values pick the largest unit
 * that stays >= 1 and keep one decimal.
 */
export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new RangeError("bytes must be a finite number >= 0");
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? value + " B" : value.toFixed(1) + " " + units[unit];
}
`,
    },
    {
      "lib/bytes.mjs": [
        "    value /= 1024;",
        "    value /= 1000; // decimal units (PROD-4155)",
      ],
    },
    `import { formatBytes } from "./lib/bytes.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  [0, "0 B"],
  [1, "1 B"],
  [1023, "1023 B"],
  [1024, "1.0 KB"],
  [1536, "1.5 KB"],
  [52428800, "50.0 MB"],
  [3221225472, "3.0 GB"],
  [1099511627776, "1.0 TB"],
];
for (const [input, expected] of cases) {
  const got = formatBytes(input);
  if (got !== expected) fail("formatBytes(" + input + ") -> " + got + ", expected " + expected);
}
for (const bad of [-1, NaN, Infinity, "100"]) {
  let threw = false;
  try { formatBytes(bad); } catch { threw = true; }
  if (!threw) fail("formatBytes(" + String(bad) + ") must throw");
}

console.log("PASS: byte sizes use binary units");
`,
  ),

  def(
    "easy",
    "word-wrap",
    "Terminal help text wraps one word too early",
    "CLI help built with lib/wrap.mjs breaks lines a column before the margin: with width 9, 'The quick brown fox' renders as three lines instead of two. A word that exactly fills the remaining width must stay on the current line. Fix the fit check in lib/wrap.mjs and verify with your own script (exact fit, long unbreakable word, hard newlines, width 1, empty string, width 0 throws) before answering.",
    {
      "lib/wrap.mjs": `/**
 * Greedy word wrap at \`width\` columns. Words are never broken; a word longer
 * than \`width\` occupies a line of its own. "\\n" in the input is a hard
 * break; runs of spaces collapse; no trailing spaces.
 */
export function wrap(text, width) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError("width must be a positive integer");
  }
  return String(text)
    .split("\\n")
    .map((line) => {
      const words = line.split(/\\s+/).filter(Boolean);
      const lines = [];
      let current = "";
      for (const word of words) {
        if (current === "") {
          current = word;
        } else if (current.length + 1 + word.length <= width) {
          current += " " + word;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current !== "") lines.push(current);
      return lines.join("\\n");
    })
    .join("\\n");
}
`,
    },
    {
      "lib/wrap.mjs": [
        "} else if (current.length + 1 + word.length <= width) {",
        "} else if (current.length + 1 + word.length < width) {",
      ],
    },
    `import { wrap } from "./lib/wrap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["The quick brown fox", 9, "The quick\\nbrown fox"],
  ["hello world", 11, "hello world"],
  ["a b c", 1, "a\\nb\\nc"],
  ["abcdefghij", 5, "abcdefghij"],
  ["hello   world", 5, "hello\\nworld"],
  ["x\\ny z", 10, "x\\ny z"],
  ["", 5, ""],
];
for (const [input, width, expected] of cases) {
  const got = wrap(input, width);
  if (got !== expected) fail("wrap(" + JSON.stringify(input) + ", " + width + ") -> " + JSON.stringify(got) + ", expected " + JSON.stringify(expected));
}
let threw = false;
try { wrap("x", 0); } catch { threw = true; }
if (!threw) fail("width 0 must throw");

console.log("PASS: greedy wrap fills lines exactly to the width");
`,
  ),

  def(
    "easy",
    "stable-stringify",
    "Config cache misses because nested key order changes the hash",
    "The config service hashes settings with lib/stable.mjs, but equal configs with different nested key order produce different hashes and evict each other from the cache. The header promises keys are sorted RECURSIVELY — top level works, nested objects do not. Fix lib/stable.mjs and verify with your own script (deep-equal objects in different key orders, arrays keep order, scalars, empty containers) before answering.",
    {
      "lib/stable.mjs": `/**
 * Deterministic JSON: object keys are sorted RECURSIVELY (nested objects
 * too), arrays keep their order, scalars go through JSON.stringify. Two
 * deep-equal values must always produce the same string.
 */
export function stableStringify(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}
`,
    },
    {
      "lib/stable.mjs": [
        '      .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]));',
        '      .map((key) => JSON.stringify(key) + ":" + JSON.stringify(value[key])); // leaves are already flat',
      ],
    },
    `import { stableStringify } from "./lib/stable.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const a = { user: "ada", prefs: { theme: "dark", lang: "en", flags: { beta: true } }, tags: ["x", "y"] };
const b = { tags: ["x", "y"], prefs: { flags: { beta: true }, lang: "en", theme: "dark" }, user: "ada" };
if (stableStringify(a) !== stableStringify(b)) fail("deep-equal objects with different key order must stringify identically");
if (stableStringify({ b: 1, a: 2 }) !== '{"a":2,"b":1}') fail("top-level keys must be sorted");
if (stableStringify([{ b: 1, a: 2 }]) !== '[{"a":2,"b":1}]') fail("keys inside arrays must be sorted too");
if (stableStringify([3, 1, 2]) !== "[3,1,2]") fail("array order must be preserved");
if (stableStringify("x") !== '"x"' || stableStringify(5) !== "5" || stableStringify(null) !== "null" || stableStringify(true) !== "true") fail("scalars broken");
if (stableStringify({}) !== "{}" || stableStringify([]) !== "[]") fail("empty containers broken");

console.log("PASS: stringify is stable under key order at every depth");
`,
  ),
];
