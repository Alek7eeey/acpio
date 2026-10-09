// Hidden verifier: imports lib.mjs directly and never runs the fixture's check.mjs.

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

let lib;
try {
  lib = await import("./lib.mjs");
} catch (err) {
  fail(`lib.mjs could not be imported: ${String(err.message).split("\n")[0]}`);
}
if (typeof lib.padLeft !== "function") {
  fail("lib.mjs does not export padLeft()");
}

const cases = [
  ["ok", 5, "   ok"],
  ["hi", 4, "  hi"],
  ["toolong", 3, "toolong"],
  ["", 3, "   "],
  ["x", 1, "x"],
  ["abc", 6, "   abc"],
];
for (const [text, width, expected] of cases) {
  let actual;
  try {
    actual = lib.padLeft(text, width);
  } catch (err) {
    fail(`padLeft(${JSON.stringify(text)}, ${width}) threw: ${String(err.message).split("\n")[0]}`);
  }
  if (actual !== expected) {
    fail(`padLeft(${JSON.stringify(text)}, ${width}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
console.log("PASS: padLeft matches every expected output");
