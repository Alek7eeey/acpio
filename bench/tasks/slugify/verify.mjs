import { slugify } from "./lib/slug.mjs";

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
