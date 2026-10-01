import { match } from "./lib/glob.mjs";

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
