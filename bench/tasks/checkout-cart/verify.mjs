import { createCart, priceLines, renderReceipt } from "./src/index.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const coupon15 = { kind: "percent", percent: 15 };
const lines = priceLines([{ sku: "note-07", qty: 1 }, { sku: "book-02", qty: 1 }], { coupon: coupon15, taxPercent: 0 });
if (lines[0].discount !== 139) fail("15% of 925 must book 139, got " + lines[0].discount);
if (lines[1].discount !== 413) fail("15% of 2750 must book 413, got " + lines[1].discount);
if (lines[0].total !== 786 || lines[1].total !== 2337) fail("discounted totals wrong: " + JSON.stringify(lines));

const cart = createCart();
cart.add("chair-04");
const withTax = priceLines(cart.lines(), { taxPercent: 8 });
if (withTax[0].tax !== 400) fail("8% of 4995 must book 400, got " + withTax[0].tax);

const scoped = priceLines([{ sku: "kbd-10", qty: 1 }, { sku: "mouse-11", qty: 1 }], {
  coupon: { kind: "percent", percent: 10, skus: ["kbd-10"] },
  taxPercent: 8,
});
if (scoped[0].discount !== 1348) fail("10% of 13475 must book 1348, got " + scoped[0].discount);
if (scoped[1].discount !== 0) fail("coupon scoped to kbd-10 must not touch mouse-11");
if (scoped[0].tax !== 970) fail("8% of discounted 12127 must book 970, got " + scoped[0].tax);

const plain = priceLines([{ sku: "mug-03", qty: 2 }], { taxPercent: 8 });
if (plain[0].tax !== 0) fail("mug-03 is not taxable");
if (plain[0].total !== 2900) fail("untaxed total wrong");

try { priceLines([{ sku: "nope-99", qty: 1 }], {}); fail("unknown sku must throw"); }
catch {}
try { createCart().add("mug-03", 0); fail("qty 0 must throw"); }
catch {}

const receipt = renderReceipt(priceLines([{ sku: "pen-06", qty: 3 }], {}));
if (receipt !== "pen-06 x3: $11.25, disc $0.00, tax $0.00, total $11.25\nTOTAL $11.25") {
  fail("receipt text wrong:\n" + receipt);
}

console.log("PASS: percent math rounds half-up everywhere on the receipt pipeline");
