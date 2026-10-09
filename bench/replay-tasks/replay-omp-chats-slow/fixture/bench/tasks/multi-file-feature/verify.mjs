// Hidden verifier: drives cart.mjs, app.mjs and cli.mjs from scratch.

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function load(file, ...exports) {
  let mod;
  try {
    mod = await import(`./${file}`);
  } catch (err) {
    fail(`${file} could not be imported: ${String(err.message).split("\n")[0]}`);
  }
  for (const name of exports) {
    if (typeof mod[name] !== "function") fail(`${file} does not export ${name}()`);
  }
  return mod;
}

function call(label, fn, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    fail(`${label} threw: ${String(err.message).split("\n")[0]}`);
  }
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

const cart = await load("cart.mjs", "cartTotal", "applyDiscount");
const app = await load("app.mjs", "orderSummary");
const cli = await load("cli.mjs", "quote");

// cartTotal on its own carts.
const totalCases = [
  [[{ sku: "apple", qty: 2 }, { sku: "cherry", qty: 1 }], 11],
  [[{ sku: "banana", qty: 5 }], 10],
  [[], 0],
];
for (const [input, expected] of totalCases) {
  const actual = call("cartTotal", cart.cartTotal, input);
  if (actual !== expected) {
    fail(`cartTotal(${JSON.stringify(input)}) = ${String(actual)}, expected ${expected}`);
  }
}

// applyDiscount, including a case where rounding actually matters.
const discountCases = [
  [100, "SAVE10", 90],
  [13, "SAVE10", 11.7],
  [23, "SAVE20", 18.4],
  [19.99, "SAVE20", 15.99],
  [123.45, "WINTER", 123.45],
  [999, "", 999],
];
for (const [total, code, expected] of discountCases) {
  const actual = call(`applyDiscount(${total}, ${JSON.stringify(code)})`, cart.applyDiscount, total, code);
  if (!near(actual, expected)) {
    fail(`applyDiscount(${total}, ${JSON.stringify(code)}) = ${String(actual)}, expected ${expected}`);
  }
}

// Integration: both callers, twice each so a mutating implementation is caught.
const summary = call("orderSummary('SAVE10')", app.orderSummary, "SAVE10");
if (!summary || summary.subtotal !== 13 || !near(summary.total, 11.7)) {
  fail(`orderSummary("SAVE10") = ${JSON.stringify(summary)}, expected { subtotal: 13, total: 11.7 }`);
}
const summaryAgain = call("orderSummary('SAVE10') again", app.orderSummary, "SAVE10");
if (JSON.stringify(summaryAgain) !== JSON.stringify(summary)) {
  fail("orderSummary is not repeatable: second call returned a different result");
}
const summaryNoPromo = call("orderSummary('PROMO')", app.orderSummary, "PROMO");
if (!summaryNoPromo || summaryNoPromo.subtotal !== 13 || !near(summaryNoPromo.total, 13)) {
  fail(`orderSummary("PROMO") = ${JSON.stringify(summaryNoPromo)}, expected { subtotal: 13, total: 13 }`);
}

const quoted = call("quote('SAVE20')", cli.quote, "SAVE20");
if (!near(quoted, 18.4)) {
  fail(`quote("SAVE20") = ${String(quoted)}, expected 18.4`);
}
const quotedAgain = call("quote('SAVE20') again", cli.quote, "SAVE20");
if (!near(quotedAgain, quoted)) {
  fail("quote is not repeatable: second call returned a different result");
}
const quotedNoPromo = call("quote('NOPE')", cli.quote, "NOPE");
if (quotedNoPromo !== 23) {
  fail(`quote("NOPE") = ${String(quotedNoPromo)}, expected 23`);
}

console.log("PASS: cart.mjs satisfies both callers end to end");
