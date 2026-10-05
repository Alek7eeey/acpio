// Hidden verifier for readme-drift-clip: every documented behavior of
// README.md, exercised through the CLI. Exact output strings follow the
// documented marker arithmetic (marker counts toward the width).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
if (!existsSync(path.join(here, "clip.js"))) fail("clip.js is missing");

function run(args) {
  const res = spawnSync(process.execPath, ["clip.js", ...args], { cwd: here, encoding: "utf8", timeoutMs: 20_000 });
  if (res.error) fail(`clip.js could not run: ${res.error.message}`);
  return { code: res.status, out: (res.stdout ?? "").replace(/\r?\n$/, ""), err: (res.stderr ?? "").trim() };
}

// The marker arithmetic: cut to width - marker.length, marker appended.
const CASES = [
  { args: ["hello world", "--width", "8"], want: "hello w…" },
  { args: ["hello world", "--width", "8", "--marker", "..."], want: "hello..." },
  { args: ["hello", "--width", "100"], want: "hello" },
  { args: ["abcdefgh", "--width", "8"], want: "abcdefgh" },
  { args: ["hello world", "--width", "8", "--at", "word"], want: "hello…" },
  { args: ["the quick brown fox", "--width", "12", "--at", "word"], want: "the quick…" },
  { args: ["hello   world", "--width", "8", "--at", "word"], want: "hello…" },
];
for (const c of CASES) {
  const r = run(c.args);
  if (r.code !== 0) fail(`clip.js ${JSON.stringify(c.args)} exited ${r.code}: ${r.err.slice(0, 120)}`);
  if (r.out !== c.want) fail(`clip.js ${JSON.stringify(c.args)} printed ${JSON.stringify(r.out)}, the README contract is ${JSON.stringify(c.want)}`);
}

// @file input; a single trailing newline is not part of the text.
const tmpTxt = path.join(here, ".verify-input.txt");
writeFileSync(tmpTxt, "goodbye world\n");
try {
  const r = run(["@.verify-input.txt", "--width", "7"]);
  if (r.code !== 0 || r.out !== "goodby…") fail(`@file input broken: printed ${JSON.stringify(r.out)}`);
} finally {
  rmSync(tmpTxt, { force: true });
}

// Missing input: usage line to stderr, exit 1, nothing on stdout.
for (const args of [[], ["--width", "8"], ["--marker", "…"]]) {
  const r = run(args);
  if (r.code !== 1) fail(`no-input case ${JSON.stringify(args)} must exit 1, got ${r.code}`);
  if (!/usage/i.test(r.err)) fail(`no-input case ${JSON.stringify(args)} must print the usage line to stderr`);
  if (/usage/i.test(r.out)) fail(`no-input case ${JSON.stringify(args)} printed usage on stdout`);
}

// The width bound holds across a spread of shapes, both modes.
const FUZZ = [
  ["truncated line stays inside the bound", "a very long sentence about nothing", "10", "char"],
  ["short text passes through any width", "short", "40", "char"],
  ["wide width keeps word mode intact", "keep this whole line", "60", "word"],
  ["tiny width word mode still obeys", "keep this whole line", "6", "word"],
  ["multi-space text in char mode", "spaces    everywhere", "12", "char"],
  ["marker length counted in word mode", "several words here", "11", "word"],
];
for (const [name, text, width, at] of FUZZ) {
  const r = run([text, "--width", width, "--at", at]);
  if (r.code !== 0) fail(`${name}: exited ${r.code}`);
  if (r.out.length > Number(width)) fail(`${name}: printed ${r.out.length} chars, bound is ${width}`);
}

console.log("PASS: clip.js matches the README on every documented behavior");
