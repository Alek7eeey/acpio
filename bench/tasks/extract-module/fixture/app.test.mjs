import { titleCase, wordCount } from "./app.mjs";

let failed = 0;
function eq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed += 1;
  }
}

eq(titleCase("hello world"), "Hello World", "titleCase basic");
eq(titleCase("  FOO   bar "), "Foo Bar", "titleCase messy");
eq(titleCase(""), "", "titleCase empty");
eq(wordCount("one two three"), 3, "wordCount basic");
eq(wordCount("  a  b "), 2, "wordCount spaced");
eq(wordCount(""), 0, "wordCount empty");

if (failed > 0) process.exit(1);
console.log("PASS: app.test.mjs");
