import { fizzbuzz } from "./fizzbuzz.mjs";

const expected = {
  1: "1",
  2: "2",
  3: "Fizz",
  5: "Buzz",
  9: "Fizz",
  10: "Buzz",
  15: "FizzBuzz",
  30: "FizzBuzz",
  7: "7",
  45: "FizzBuzz",
  98: "98",
  99: "Fizz",
  100: "Buzz",
};

if (typeof fizzbuzz !== "function") {
  console.error("FAIL: fizzbuzz.mjs does not export a function named fizzbuzz");
  process.exit(1);
}
for (const [input, want] of Object.entries(expected)) {
  const got = fizzbuzz(Number(input));
  if (got !== want) {
    console.error(`FAIL: fizzbuzz(${input}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    process.exit(1);
  }
}
console.log("PASS: fizzbuzz is correct");
