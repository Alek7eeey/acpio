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

  def(
    "easy",
    "parse-duration",
    "Scheduler treats 1m30s as 31 seconds",
    "The retry planner reads human durations like 1m30s, and since last week every timeout that mixes units collapses: 1m30s parses to 31 seconds instead of 90. The unit table in lib/duration.mjs is the single source of truth for what a unit is worth — check it against its own header. Fix lib/duration.mjs and verify with your own script (single units, mixed units, bare milliseconds, whitespace between chunks, invalid input throws) before answering.",
    {
      "lib/duration.mjs": `/**
 * Parse human durations ("1h30m", "90s", "500ms", "2d") into milliseconds.
 * Units: ms, s, m, h, d. Whitespace between chunks is fine; a bare number
 * counts as milliseconds; anything else is a TypeError.
 */
const UNITS = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input) {
  const text = String(input).trim();
  if (text === "") throw new TypeError("empty duration");
  if (/^\\d+$/.test(text)) return Number(text);
  if (!/^(?:\\d+\\s*(?:ms|s|m|h|d)\\s*)+$/.test(text)) throw new TypeError("not a duration: " + input);
  let total = 0;
  for (const [, num, unit] of text.matchAll(/(\\d+)\\s*(ms|s|m|h|d)/g)) {
    total += Number(num) * UNITS[unit];
  }
  return total;
}
`,
    },
    {
      "lib/duration.mjs": [
        "  m: 60_000,",
        '  m: 1000, // "small minutes", matches the old 1.0 config format (PROD-4455)',
      ],
    },
    `import { parseDuration } from "./lib/duration.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const cases = [
  ["90s", 90000],
  ["500ms", 500],
  ["1m", 60000],
  ["1m30s", 90000],
  ["1h30m", 5400000],
  ["2d", 172800000],
  ["1h 30m", 5400000],
  ["0ms", 0],
  ["1500", 1500],
];
for (const [input, expected] of cases) {
  const got = parseDuration(input);
  if (got !== expected) fail("parseDuration(" + JSON.stringify(input) + ") -> " + got + ", expected " + expected);
}
for (const bad of ["", "abc", "1x", "1h30", "-5s", "m"]) {
  let threw = false;
  try { parseDuration(bad); } catch { threw = true; }
  if (!threw) fail("parseDuration(" + JSON.stringify(bad) + ") must throw");
}

console.log("PASS: durations parse with the documented unit table");
`,
  ),

  def(
    "easy",
    "camelize-keys",
    "Nested keys stay snake_case after the API response mapping",
    "The API client maps response keys to camelCase, but since a cleanup only the TOP-LEVEL keys are converted: payload.profile.display_name and objects inside arrays keep their underscores, and the UI reads undefined. The header of lib/camelize.mjs promises the conversion runs RECURSIVELY — nested objects and arrays of objects included. Fix lib/camelize.mjs and verify with your own script (deep nesting, arrays of objects, kebab-case keys, digit keys, scalars, input not mutated) before answering.",
    {
      "lib/camelize.mjs": `/**
 * Convert object keys from snake_case / kebab-case to camelCase,
 * RECURSIVELY: nested objects and arrays of objects are converted too.
 * Every '_' or '-' followed by a letter or digit uppercases that character.
 * The input is never mutated.
 */
function camelizeKey(key) {
  return key.replace(/[_-]([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase());
}

export function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[camelizeKey(key)] = camelize(item);
    }
    return out;
  }
  return value;
}
`,
    },
    {
      "lib/camelize.mjs": [
        "      out[camelizeKey(key)] = camelize(item);",
        "      out[camelizeKey(key)] = item; // leaves are flat, nothing to descend into (PROD-4463)",
      ],
    },
    `import { camelize } from "./lib/camelize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const payload = { user_id: 7, profile: { display_name: "Ada", contact: { home_town: "Lyn" } }, tags: [{ tag_id: 3 }] };
const mapped = camelize(payload);
if (!eq(mapped, { userId: 7, profile: { displayName: "Ada", contact: { homeTown: "Lyn" } }, tags: [{ tagId: 3 }] })) {
  fail("deep conversion broken: " + JSON.stringify(mapped));
}
if (!eq(camelize([{ first_name: "a" }, { first_name: "b" }]), [{ firstName: "a" }, { firstName: "b" }])) fail("arrays of objects broken");
if (!eq(camelize({ "created-at": "x", sha256_hash: "y" }), { createdAt: "x", sha256Hash: "y" })) fail("kebab and digit keys broken");
if (camelize("plain") !== "plain" || camelize(5) !== 5 || camelize(null) !== null) fail("scalars must pass through");
if (camelize({ alreadyCamel: 1 }).alreadyCamel !== 1) fail("camel keys must stay");
if (!eq(payload, { user_id: 7, profile: { display_name: "Ada", contact: { home_town: "Lyn" } }, tags: [{ tag_id: 3 }] })) fail("input was mutated");
if (!eq(camelize({}), {}) || !eq(camelize([]), [])) fail("empty containers broken");

console.log("PASS: keys camelize recursively, input stays intact");
`,
  ),

  def(
    "easy",
    "clean-params",
    "page=0 and enabled=false vanish from API requests",
    "Clients report that requesting page 0 or sending enabled=false drops the parameter entirely, so the backend falls back to its defaults. lib/params.mjs is specified to drop ONLY null, undefined and empty-string values — a real 0 or false is a meaningful value and must survive. Fix lib/params.mjs and verify with your own script (zero, false, empty string, null, undefined, lone values, input not mutated) before answering.",
    {
      "lib/params.mjs": `/**
 * Query params for the API client: drop keys whose value is null,
 * undefined or "" — a real 0 or false is meaningful and MUST stay. The
 * input object is never mutated.
 */
export function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}
`,
    },
    {
      "lib/params.mjs": [
        '    if (value === null || value === undefined || value === "") continue;',
        '    if (!value) continue; // falsy values are "not set" anyway (PROD-4438)',
      ],
    },
    `import { cleanParams } from "./lib/params.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const input = { page: 0, enabled: false, q: "", label: null, extra: undefined, name: "x", size: 5 };
const cleaned = cleanParams(input);
if (!eq(cleaned, { page: 0, enabled: false, name: "x", size: 5 })) {
  fail("0 and false must survive, empty/null/undefined must go: " + JSON.stringify(cleaned));
}
if (!eq(input, { page: 0, enabled: false, q: "", label: null, extra: undefined, name: "x", size: 5 })) fail("input was mutated");
if (!eq(cleanParams({}), {})) fail("empty input");
if (!eq(cleanParams({ a: null, b: "" }), {})) fail("all-dropped input");
if (!eq(cleanParams({ n: 0 }), { n: 0 })) fail("lone zero must survive");
if (!eq(cleanParams({ ok: false }), { ok: false })) fail("lone false must survive");

console.log("PASS: only null/undefined/empty-string are dropped");
`,
  ),

  def(
    "easy",
    "dedent-block",
    "Generated snippets ship with their template indentation",
    "Email templates built with lib/dedent.mjs come out indented by four spaces since a refactor: the common indent is no longer stripped. The header documents the rule — the indent is the shortest run of leading spaces over lines that contain any non-whitespace; blank lines never take part in that minimum and are left as they are. Fix lib/dedent.mjs and verify with your own script (uniform indent, blank lines mid-text, mixed depths, no indent at all, all-blank input, tabs stay) before answering.",
    {
      "lib/dedent.mjs": `/**
 * Remove the COMMON leading indentation from every line. The indent is the
 * shortest run of leading spaces over lines that contain any non-whitespace
 * — blank lines never count toward that minimum and are left untouched.
 * Tabs are not indentation.
 */
export function dedent(text) {
  const lines = String(text).split("\\n");
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const spaces = /^ */.exec(line)[0].length;
    if (spaces < indent) indent = spaces;
  }
  if (indent === Infinity) indent = 0;
  return lines.map((line) => (line.trim() === "" ? line : line.slice(indent))).join("\\n");
}
`,
    },
    {
      "lib/dedent.mjs": [
        '    if (line.trim() === "") continue;',
        "    // blank lines are just lines with zero indent (PROD-4441)",
      ],
    },
    `import { dedent } from "./lib/dedent.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(dedent("    hello\\n    world"), "hello\\nworld")) fail("uniform indent broken: " + JSON.stringify(dedent("    hello\\n    world")));
if (!eq(dedent("  a\\n\\n  b"), "a\\n\\nb")) fail("blank lines must not pin the indent to zero: " + JSON.stringify(dedent("  a\\n\\n  b")));
if (!eq(dedent("    x\\n  y"), "  x\\ny")) fail("the shallowest line sets the indent");
if (!eq(dedent("noindent\\n  deep"), "noindent\\n  deep")) fail("zero indent must be a no-op");
if (!eq(dedent("  only"), "only")) fail("single line");
if (!eq(dedent(""), "")) fail("empty input");
if (!eq(dedent("\\n\\n"), "\\n\\n")) fail("all-blank input must pass through");
if (!eq(dedent("\\ttabbed"), "\\ttabbed")) fail("tabs are not indentation");

console.log("PASS: the common indent goes, blank lines do not pin it");
`,
  ),

  def(
    "easy",
    "group-by",
    "Grouped buckets keep only the last item per key",
    "The billing page groups invoices by account and shows ONE invoice per account — the earlier ones are gone. lib/group.mjs is documented to map every key to ALL items that produced it, in input order; somewhere that collect-then-append was reduced to a plain overwrite. Fix lib/group.mjs and verify with your own script (repeated keys, single hits, numeric keys via String(), empty input, bucket order) before answering.",
    {
      "lib/group.mjs": `/**
 * Group items by a string key: the result maps each key to ALL items that
 * produced it, in input order. Keys are stringified with String(key).
 */
export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = String(keyOf(item));
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
`,
    },
    {
      "lib/group.mjs": [
        [
          "    const bucket = groups.get(key);",
          "    if (bucket) bucket.push(item);",
          "    else groups.set(key, [item]);",
        ].join("\n"),
        "    groups.set(key, [item]); // one item per key is all the UI shows anyway (PROD-4447)",
      ],
    },
    `import { groupBy } from "./lib/group.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const items = [
  { account: "acme", id: 1 },
  { account: "glob", id: 2 },
  { account: "acme", id: 3 },
  { account: "acme", id: 4 },
  { account: "glob", id: 5 },
];
const groups = groupBy(items, (item) => item.account);
if (groups.size !== 2) fail("expected 2 buckets, got " + groups.size);
if (!eq(groups.get("acme"), [{ account: "acme", id: 1 }, { account: "acme", id: 3 }, { account: "acme", id: 4 }])) {
  fail("acme must collect all three invoices in input order: " + JSON.stringify(groups.get("acme")));
}
if (!eq(groups.get("glob"), [{ account: "glob", id: 2 }, { account: "glob", id: 5 }])) fail("glob bucket broken");

const numeric = groupBy([1, "1", 2], (x) => x);
if (numeric.size !== 2 || !eq(numeric.get("1"), [1, "1"])) fail("keys must be stringified: " + JSON.stringify([...numeric]));
if (groupBy([], (x) => x).size !== 0) fail("empty input");
if (groupBy([9], (x) => x).get("9")[0] !== 9) fail("single item");

console.log("PASS: every key maps to all of its items, in order");
`,
  ),

  def(
    "easy",
    "mask-secret",
    "Error logs print the first half of API tokens",
    "A customer pasted a support bundle and the first characters of their API key were right there in the log line. lib/mask.mjs is the redaction helper for log fields; its header states the policy: everything but the LAST 4 characters becomes '*', secrets of 4 chars or fewer are masked completely. After a make-support-easier change the helper keeps the FIRST characters instead — a leak. Fix lib/mask.mjs and verify with your own script (long tokens, 5-char secret, 4-char and shorter, empty string, non-string input throws) before answering.",
    {
      "lib/mask.mjs": `/**
 * Mask a secret for logs: everything but the LAST 4 characters becomes '*'.
 * Secrets of 4 chars or fewer are masked completely — never reveal a whole
 * secret, no matter how short. Non-string input is a TypeError.
 */
export function maskSecret(secret) {
  if (typeof secret !== "string") throw new TypeError("secret must be a string");
  if (secret.length <= 4) return "*".repeat(secret.length);
  return "*".repeat(secret.length - 4) + secret.slice(-4);
}
`,
    },
    {
      "lib/mask.mjs": [
        '  return "*".repeat(secret.length - 4) + secret.slice(-4);',
        '  return secret.slice(0, 4) + "*".repeat(secret.length - 4); // keep the prefix so support can spot the key (PROD-4452)',
      ],
    },
    `import { maskSecret } from "./lib/mask.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (maskSecret("sk-live-12345678") !== "************5678") fail("long token broken: " + maskSecret("sk-live-12345678"));
if (maskSecret("abcde") !== "*bcde") fail("5-char secret broken: " + maskSecret("abcde"));
if (maskSecret("abcd") !== "****") fail("4-char secret must be masked completely");
if (maskSecret("abc") !== "***") fail("3-char secret");
if (maskSecret("a") !== "*") fail("1-char secret");
if (maskSecret("") !== "") fail("empty string");
for (const bad of [5, null, undefined, { length: 8 }]) {
  let threw = false;
  try { maskSecret(bad); } catch { threw = true; }
  if (!threw) fail("maskSecret(" + String(bad) + ") must throw");
}

console.log("PASS: only the last four characters stay visible");
`,
  ),

  def(
    "easy",
    "series-waterfall",
    "Pipeline steps run simultaneously and each gets the initial input",
    "The import pipeline is a waterfall: step 2 must see step 1's output. Since a speed-things-up change all steps start at once and each receives the ORIGINAL input, so the importer never sees the loader's normalized rows. lib/waterfall.mjs documents the contract: run tasks one at a time in order, pass each task the previous task's return value (the first task gets initial), resolve with all results in order, and never start a task after one failed. Fix lib/waterfall.mjs and verify with your own script (start order, result chaining, abort on failure, empty input) before answering.",
    {
      "lib/waterfall.mjs": `/**
 * Run async tasks ONE AT A TIME, in order: task N receives the value
 * returned by task N-1 as its argument (the first task gets \`initial\`).
 * Resolves with every result in order. A failing task rejects the whole
 * waterfall immediately — later tasks must never start.
 */
export async function waterfall(tasks, initial) {
  const results = [];
  let acc = initial;
  for (const task of tasks) {
    acc = await task(acc);
    results.push(acc);
  }
  return results;
}
`,
    },
    {
      "lib/waterfall.mjs": [
        [
          "  const results = [];",
          "  let acc = initial;",
          "  for (const task of tasks) {",
          "    acc = await task(acc);",
          "    results.push(acc);",
          "  }",
          "  return results;",
        ].join("\n"),
        "  // the steps are independent, fire them together (PROD-4458)\n  return Promise.all(tasks.map((task) => task(initial)));",
      ],
    },
    `import { waterfall } from "./lib/waterfall.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let inFlight = 0;
const step = (name, value) => async (input) => {
  inFlight++;
  if (inFlight !== 1) fail("task " + name + " started while another task was still running");
  await sleep(10);
  inFlight--;
  return input + value;
};

const results = await waterfall([step("a", 1), step("b", 10), step("c", 100)], 0);
if (results.join(",") !== "1,11,111") fail("each task must receive the previous result: " + results.join(","));

let threw = false;
const started = [];
try {
  await waterfall([
    async () => { started.push("x"); return 1; },
    async () => { throw new Error("stop here"); },
    async () => { started.push("z"); return 3; },
  ], 0);
} catch (err) { threw = err.message === "stop here"; }
if (!threw) fail("a failing task must reject the waterfall");
if (started.join(",") !== "x") fail("tasks after a failure must never start, started " + started.join(","));

const empty = await waterfall([], 7);
if (empty.length !== 0) fail("no tasks, no results");

console.log("PASS: waterfall runs steps in series and chains their results");
`,
  ),

  def(
    "easy",
    "rank-ties",
    "Tied scores get different ranks",
    "The leaderboard shows tied players with different ranks — two players with 150 points show as #2 and #3. lib/rank.mjs documents competition ranking ('1,2,2,4'): equals share a rank and the next distinct score lands one past the whole tie group. A cleanup pass lost the sharing. Fix lib/rank.mjs and verify with your own script (tie in the middle, three-way tie at the top, no ties, single entry, empty input, input order preserved) before answering.",
    {
      "lib/rank.mjs": `/**
 * Competition ranking ("1,2,2,4"): entries with equal scores share a rank,
 * and the next distinct score ranks one past the whole tie group (its
 * position in the descending order + 1). Equals keep their input order.
 * Returns the rank of every input item, in input order.
 */
export function rankBy(items, scoreOf) {
  const order = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const rankOf = new Map();
  for (let i = 0; i < order.length; i++) {
    if (i > 0 && scoreOf(order[i]) === scoreOf(order[i - 1])) {
      rankOf.set(order[i], rankOf.get(order[i - 1])); // equals share the rank of their group
      continue;
    }
    rankOf.set(order[i], i + 1);
  }
  return items.map((item) => rankOf.get(item));
}
`,
    },
    {
      "lib/rank.mjs": [
        "    if (i > 0 && scoreOf(order[i]) === scoreOf(order[i - 1])) {\n      rankOf.set(order[i], rankOf.get(order[i - 1])); // equals share the rank of their group\n      continue;\n    }\n    rankOf.set(order[i], i + 1);",
        "    rankOf.set(order[i], i + 1); // every entry is ranked by its own position (PROD-4512)",
      ],
    },
    `import { rankBy } from "./lib/rank.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const score = (p) => p.points;

const board = [
  { name: "ada", points: 150 },
  { name: "bo", points: 210 },
  { name: "cy", points: 150 },
  { name: "dee", points: 90 },
];
if (!eq(rankBy(board, score), [2, 1, 2, 4])) {
  fail("150/210/150/90 must rank 2,1,2,4: " + JSON.stringify(rankBy(board, score)));
}

const top = [{ name: "a", points: 5 }, { name: "b", points: 5 }, { name: "c", points: 5 }];
if (!eq(rankBy(top, score), [1, 1, 1])) fail("three-way tie at the top shares rank 1");
if (!eq(rankBy([{ name: "x", points: 3 }], score), [1])) fail("single entry ranks 1");
if (!eq(rankBy([], score), [])) fail("empty input");
if (!eq(rankBy([{ v: 1 }, { v: 2 }], (p) => p.v), [2, 1])) fail("no ties ranks by score");

console.log("PASS: equals share a rank, the next distinct score skips past them");
`,
  ),

  def(
    "easy",
    "rental-days",
    "Weekend rentals are billed one day short",
    "Customer complaints: a Friday-to-Sunday rental is billed for 2 days, and same-day rentals come out free. lib/days.mjs documents billing as INCLUSIVE of both the pickup and the return day. Fix lib/days.mjs and verify with your own script (same-day, weekend, full month, cross-month, return before pickup throws, garbage input throws) before answering.",
    {
      "lib/days.mjs": `/**
 * Billing days for a rental, INCLUSIVE of both the pickup and the return
 * day: the same day picked up and returned is 1 day, Fri -> Sun is 3.
 * Dates are ISO "YYYY-MM-DD" (no time component). A return before the
 * pickup is a RangeError; a non-ISO date is a TypeError.
 */
export function billingDays(startISO, endISO) {
  const start = Date.parse(startISO + "T00:00:00Z");
  const end = Date.parse(endISO + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) throw new TypeError("dates must be ISO YYYY-MM-DD");
  if (end < start) throw new RangeError("return before pickup");
  return Math.round((end - start) / 86_400_000) + 1;
}
`,
    },
    {
      "lib/days.mjs": [
        "  return Math.round((end - start) / 86_400_000) + 1;",
        "  return Math.round((end - start) / 86_400_000); // count the nights, not the calendar days (PROD-4513)",
      ],
    },
    `import { billingDays } from "./lib/days.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

if (billingDays("2026-10-02", "2026-10-04") !== 3) fail("Fri -> Sun is 3 billing days");
if (billingDays("2026-10-02", "2026-10-02") !== 1) fail("same-day rental is 1 day");
if (billingDays("2026-01-01", "2026-01-31") !== 31) fail("January is 31 billing days");
if (billingDays("2026-01-30", "2026-02-02") !== 4) fail("cross-month span is inclusive");
throws(() => billingDays("2026-02-10", "2026-02-09"), "return before pickup");
throws(() => billingDays("not-a-date", "2026-02-09"), "garbage start");

console.log("PASS: billing days are inclusive of both ends");
`,
  ),

  def(
    "easy",
    "flag-parse",
    "A CLI flag set to false still turns the feature on",
    "Deploy runs with --dry-run=false executed for real. lib/flags.mjs documents the coercion: the exact strings 'true'/'false' become booleans, comma values become arrays, finite numbers become numbers, anything else stays a string. After a cleanup the boolean case is gone. Fix lib/flags.mjs and verify with your own script (--dry-run=false, --verbose=true, bare --verbose, --tags=a,b,c, --retries=3, --label=live, --flag=, non-flag args ignored) before answering.",
    {
      "lib/flags.mjs": `/**
 * argv flag parser: only "--name=value" and bare "--name" forms. Coercion
 * of the value: the exact strings "true"/"false" become booleans (whole
 * match, case-sensitive — "False" stays a string), a comma-containing
 * value becomes an array of strings, a finite number becomes a number,
 * anything else stays a string. "--flag=" is the empty string.
 */
export function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      flags[arg.slice(2)] = true;
      continue;
    }
    const name = arg.slice(2, eq);
    const raw = arg.slice(eq + 1);
    if (raw === "true") flags[name] = true;
    else if (raw === "false") flags[name] = false;
    else if (raw.includes(",")) flags[name] = raw.split(",");
    else if (raw !== "" && Number.isFinite(Number(raw))) flags[name] = Number(raw);
    else flags[name] = raw;
  }
  return flags;
}
`,
    },
    {
      "lib/flags.mjs": [
        '    if (raw === "true") flags[name] = true;\n    else if (raw === "false") flags[name] = false;\n    else if (raw.includes(",")) flags[name] = raw.split(",");\n    else if (raw !== "" && Number.isFinite(Number(raw))) flags[name] = Number(raw);\n    else flags[name] = raw;',
        '    flags[name] = raw !== "" && raw !== "0"; // a set flag is on; only empty and "0" are off (PROD-4514)',
      ],
    },
    `import { parseFlags } from "./lib/flags.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const f = parseFlags(["deploy", "--dry-run=false", "--verbose=true", "--quiet", "--tags=a,b,c", "--retries=3", "--label=live", "--flag=", "positional"]);
if (f["dry-run"] !== false) fail("dry-run=false must be the boolean false: " + JSON.stringify(f["dry-run"]));
if (f.verbose !== true) fail("verbose=true must be the boolean true");
if (f.quiet !== true) fail("bare --name must be the boolean true");
if (!eq(f.tags, ["a", "b", "c"])) fail("comma value must become an array");
if (f.retries !== 3) fail("numeric value must become a number: " + JSON.stringify(f.retries));
if (f.label !== "live") fail("plain value must stay a string: " + JSON.stringify(f.label));
if (f.flag !== "") fail("empty value is the empty string");
if (f.deploy !== undefined || f.positional !== undefined) fail("non-flag args are ignored");

console.log("PASS: booleans, arrays, numbers and strings coerce per the contract");
`,
  ),

  def(
    "easy",
    "trim-suffix",
    "Path cleaner strips more separators than it should",
    "Our path sanitizer eats ALL trailing separators: a user path 'a///' comes back as 'a' and the tests that pin 'a//' now fail. lib/trim.mjs documents the contract: remove AT MOST ONE trailing occurrence of the suffix; a text that is exactly the suffix becomes the empty string. Fix lib/trim.mjs and verify with your own script (triple slash, single slash, text equal to the suffix, no match, empty text, multi-char suffix, overlapping suffix) before answering.",
    {
      "lib/trim.mjs": `/**
 * Remove AT MOST ONE trailing occurrence of 'suffix' from 'text':
 * strip("a///", "/") is "a//", never "a". A text that IS the suffix
 * becomes the empty string. A text not ending with the suffix is
 * returned unchanged. An empty suffix changes nothing.
 */
export function stripSuffix(text, suffix) {
  if (suffix === "") return text;
  if (!text.endsWith(suffix)) return text;
  return text.slice(0, text.length - suffix.length);
}
`,
    },
    {
      "lib/trim.mjs": [
        "  if (!text.endsWith(suffix)) return text;\n  return text.slice(0, text.length - suffix.length);",
        "  while (text.endsWith(suffix)) text = text.slice(0, text.length - suffix.length); // users paste doubled separators (PROD-4515)\n  return text;",
      ],
    },
    `import { stripSuffix } from "./lib/trim.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (stripSuffix("a///", "/") !== "a//") fail("only one separator goes away: " + JSON.stringify(stripSuffix("a///", "/")));
if (stripSuffix("path/", "/") !== "path") fail("single trailing slash");
if (stripSuffix("/", "/") !== "") fail("text equal to the suffix becomes empty");
if (stripSuffix("abc", "x") !== "abc") fail("no match returns the input");
if (stripSuffix("", "/") !== "") fail("empty text stays empty");
if (stripSuffix("report.tar.gz", ".gz") !== "report.tar") fail("multi-char suffix");
if (stripSuffix("aaa", "aa") !== "a") fail("overlapping suffix strips once");

console.log("PASS: at most one trailing occurrence is removed");
`,
  ),

  def(
    "easy",
    "pad-id",
    "Orders beyond a million collide on the printed label",
    "Order 1000000 prints as ORD-000000 — the same label as order 0. lib/id.mjs documents the width as a FLOOR: sequences above six digits keep every digit, truncation would collide two orders. Fix lib/id.mjs and verify with your own script (small ids, exactly six digits, seven digits, eight digits, zero, negative throws, fractional throws) before answering.",
    {
      "lib/id.mjs": `/**
 * Human-facing order id: "ORD-" + the sequence zero-padded to AT LEAST six
 * digits. Six is a floor, not a cap — sequences above 999999 keep every
 * digit (truncating would make two orders share an id). seq must be a
 * non-negative integer.
 */
export function formatOrderId(seq) {
  if (!Number.isInteger(seq) || seq < 0) throw new TypeError("seq must be a non-negative integer");
  return "ORD-" + String(seq).padStart(6, "0");
}
`,
    },
    {
      "lib/id.mjs": [
        '  return "ORD-" + String(seq).padStart(6, "0");',
        '  return "ORD-" + String(seq).padStart(6, "0").slice(-6); // the label printer wants exactly six (PROD-4516)',
      ],
    },
    `import { formatOrderId } from "./lib/id.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

if (formatOrderId(42) !== "ORD-000042") fail("small ids pad to six");
if (formatOrderId(0) !== "ORD-000000") fail("zero pads to six");
if (formatOrderId(999999) !== "ORD-999999") fail("exactly six digits stay six");
if (formatOrderId(1000000) !== "ORD-1000000") fail("a million keeps all seven digits: " + formatOrderId(1000000));
if (formatOrderId(12345678) !== "ORD-12345678") fail("eight digits keep all eight");
throws(() => formatOrderId(-1), "negative seq");
throws(() => formatOrderId(4.2), "fractional seq");

console.log("PASS: six digits is a floor, ids never collide by truncation");
`,
  ),
];
