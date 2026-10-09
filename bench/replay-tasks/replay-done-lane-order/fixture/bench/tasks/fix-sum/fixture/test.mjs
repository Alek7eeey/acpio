import { add } from "./calc.mjs";

if (add(2, 3) !== 5) {
  console.error("FAIL: add(2, 3) =", add(2, 3));
  process.exit(1);
}
console.log("PASS");
