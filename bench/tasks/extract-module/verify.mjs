// Hidden verifier: never imports the fixture's own test file.

import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// utils.mjs must exist and export titleCase.
let utils;
try {
  utils = await import("./utils.mjs");
} catch (err) {
  fail(`utils.mjs missing or not importable: ${String(err.message).split("\n")[0]}`);
}
if (typeof utils.titleCase !== "function") {
  fail("utils.mjs does not export titleCase");
}

// app.mjs must import titleCase from utils.mjs and not define it locally.
let appSrc;
try {
  appSrc = readFileSync("./app.mjs", "utf8");
} catch (err) {
  fail(`app.mjs missing: ${String(err.message).split("\n")[0]}`);
}
if (!/import\s*\{[^}]*\btitleCase\b[^}]*\}\s*from\s*["'][.][\\/]utils\.mjs["']/.test(appSrc)) {
  fail('app.mjs does not import { titleCase } from "./utils.mjs"');
}
if (/function\s+titleCase\s*\(/.test(appSrc) || /(?:const|let|var)\s+titleCase\s*=/.test(appSrc)) {
  fail("app.mjs still defines titleCase locally instead of importing it from utils.mjs");
}

// Behaviour of both functions, unchanged, via the original public interface.
let app;
try {
  app = await import("./app.mjs");
} catch (err) {
  fail(`app.mjs not importable: ${String(err.message).split("\n")[0]}`);
}
if (typeof app.titleCase !== "function") fail("app.mjs no longer exports titleCase");
if (typeof app.wordCount !== "function") fail("app.mjs no longer exports wordCount");

const titleCases = [
  ["hello world", "Hello World"],
  ["  FOO   bar ", "Foo Bar"],
  ["", ""],
  ["a", "A"],
  ["already Fine", "Already Fine"],
];
for (const [input, expected] of titleCases) {
  let viaUtils;
  let viaApp;
  try {
    viaUtils = utils.titleCase(input);
    viaApp = app.titleCase(input);
  } catch (err) {
    fail(`titleCase(${JSON.stringify(input)}) threw: ${String(err.message).split("\n")[0]}`);
  }
  if (viaUtils !== expected) {
    fail(`utils.titleCase(${JSON.stringify(input)}) = ${JSON.stringify(viaUtils)}, expected ${JSON.stringify(expected)}`);
  }
  if (viaApp !== expected) {
    fail(`app.titleCase(${JSON.stringify(input)}) = ${JSON.stringify(viaApp)}, expected ${JSON.stringify(expected)}`);
  }
}

const wordCases = [
  ["one two three", 3],
  ["  a  b ", 2],
  ["", 0],
  ["Hello World", 2],
  ["single", 1],
];
for (const [input, expected] of wordCases) {
  let actual;
  try {
    actual = app.wordCount(input);
  } catch (err) {
    fail(`wordCount(${JSON.stringify(input)}) threw: ${String(err.message).split("\n")[0]}`);
  }
  if (actual !== expected) {
    fail(`wordCount(${JSON.stringify(input)}) = ${String(actual)}, expected ${expected}`);
  }
}

console.log("PASS: titleCase lives in utils.mjs, both functions unchanged");
