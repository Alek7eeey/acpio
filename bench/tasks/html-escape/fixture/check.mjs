import { escapeHtml } from "./lib/escape.mjs";

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
