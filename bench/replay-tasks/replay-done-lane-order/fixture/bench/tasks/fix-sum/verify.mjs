// Hidden verifier: never trusts the fixture's own test file.
import { add } from "./calc.mjs";

const cases = [
  [2, 3, 5],
  [0, 0, 0],
  [-4, 4, 0],
  [10, -3, 7],
  [0.5, 0.25, 0.75],
];
for (const [a, b, expected] of cases) {
  const actual = add(a, b);
  if (actual !== expected) {
    console.error(`FAIL: add(${a}, ${b}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
}
console.log("PASS: add is correct");
