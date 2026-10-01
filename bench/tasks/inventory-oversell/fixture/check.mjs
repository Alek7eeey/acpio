import { createStock } from "./src/stock.mjs";
import { placeOrder } from "./src/orders.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const stock = createStock();
placeOrder(stock, { id: "o1", lines: [{ sku: "mug-01", qty: 2 }, { sku: "tee-02", qty: 1 }] });
if (stock.freeLevel("mug-01") !== 3) fail("mug stock after order: " + stock.freeLevel("mug-01"));
stock.release("o1");
if (stock.freeLevel("mug-01") !== 5 || stock.freeLevel("tee-02") !== 3) fail("release must restore stock");

try {
  placeOrder(stock, { id: "o2", lines: [{ sku: "mug-01", qty: 99 }] });
  fail("oversell must throw");
} catch {}

console.log("PASS: orders reserve atomically");
