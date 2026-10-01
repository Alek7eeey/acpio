// Hidden verifier: checks lib/geom.mjs directly with its own cases and never
// imports the fixture's tests — a test edited to match the bug still fails here.
import { spawnSync } from "node:child_process";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let geom;
try {
  geom = await import("./lib/geom.mjs");
} catch (err) {
  fail(`lib/geom.mjs could not be imported: ${String(err.message).split("\n")[0]}`);
}
const { median, round2, slugify } = geom;
for (const [name, fn] of [["median", median], ["round2", round2], ["slugify", slugify]]) {
  if (typeof fn !== "function") fail(`lib/geom.mjs does not export ${name}()`);
}

const medianCases = [
  [[3, 1, 2], 2],
  [[5], 5],
  [[9, 7, 5, 3, 1], 5],
  [[4, 1, 3, 2], 2.5],
  [[10, 20], 15],
  [[-1, -3, -2], -2],
];
for (const [input, expected] of medianCases) {
  const actual = median(input);
  if (actual !== expected) {
    fail(`median(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${expected}`);
  }
}

const roundCases = [
  [3.14159, 3.14],
  [2, 2],
  [2.5, 2.5],
  [-1.234, -1.23],
];
for (const [input, expected] of roundCases) {
  const actual = round2(input);
  if (actual !== expected) {
    fail(`round2(${input}) = ${JSON.stringify(actual)}, expected ${expected}`);
  }
}

const slugCases = [
  ["Hello, World!", "hello-world"],
  ["  a  b  ", "a-b"],
  ["AlReAdY-dashed", "already-dashed"],
  ["Mix 3 Words", "mix-3-words"],
];
for (const [input, expected] of slugCases) {
  const actual = slugify(input);
  if (actual !== expected) {
    fail(`slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

// The suite must also be green as the agent left it. Bare `--test` (no path):
// `node --test test/` breaks on Windows (trailing slash → MODULE_NOT_FOUND).
const run = spawnSync(process.execPath, ["--test"], { encoding: "utf8" });
if (run.status !== 0 || run.error) {
  fail(`node --test exits ${run.status ?? run.error} — the suite the agent left behind is red`);
}

console.log("PASS: median/round2/slugify match every expected output and the suite is green");
