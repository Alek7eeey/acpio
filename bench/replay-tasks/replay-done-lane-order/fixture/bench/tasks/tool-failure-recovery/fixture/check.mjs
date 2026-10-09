import { padLeft } from "./lib.mjs";

const cases = [
  ["ok", 5, "   ok"],
  ["hi", 4, "  hi"],
  ["toolong", 3, "toolong"],
  ["", 3, "   "],
];

for (const [text, width, expected] of cases) {
  const actual = padLeft(text, width);
  if (actual !== expected) {
    throw new Error(
      `padLeft(${JSON.stringify(text)}, ${width}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} — the bug is in lib.mjs, fix it there.`,
    );
  }
}
console.log("PASS: padLeft behaves as specified");
