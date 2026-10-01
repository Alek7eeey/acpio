import { createStock } from "./src/stock.mjs";
import { placeOrder } from "./src/orders.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const s = createStock();
if (s.freeLevel("cap-03") !== 0) fail("cap starts at 0");
if (s.freeLevel("sock-04") !== 12) fail("socks start at 12");

const o1 = placeOrder(s, { id: "o1", lines: [{ sku: "mug-01", qty: 2 }, { sku: "sock-04", qty: 4 }] });
if (o1.lines.length !== 2) fail("order must echo its lines");
if (s.freeLevel("mug-01") !== 3 || s.freeLevel("sock-04") !== 8) fail("levels after o1: " + s.freeLevel("mug-01") + "/" + s.freeLevel("sock-04"));
if (JSON.stringify(s.reservationsOf("o1")) !== JSON.stringify([{ sku: "mug-01", qty: 2 }, { sku: "sock-04", qty: 4 }])) fail("reservations must be recorded per order");

let threw = false;
try { s.reserve("mug-01", 4, "o2"); } catch { threw = true; }
if (!threw) fail("reserving 4 mugs with 3 free must throw");
if (s.freeLevel("mug-01") !== 3) fail("a failed reserve must leave the level untouched, got " + s.freeLevel("mug-01"));
if (s.reservationsOf("o2").length !== 0) fail("a failed reserve must not record a reservation");

threw = false;
try { s.reserve("cap-03", 1, "o3"); } catch { threw = true; }
if (!threw) fail("reserving an out-of-stock sku must throw");

threw = false;
try { placeOrder(s, { id: "o4", lines: [{ sku: "tee-02", qty: 2 }, { sku: "tee-02", qty: 2 }] }); }
catch { threw = true; }
if (!threw) fail("an order that cannot fully reserve must throw");
if (s.freeLevel("tee-02") !== 3) fail("a failed order must release partial reservations, tee free = " + s.freeLevel("tee-02"));
if (s.reservationsOf("o4").length !== 0) fail("a failed order must leave no reservations");

s.release("o1");
if (s.freeLevel("mug-01") !== 5 || s.freeLevel("sock-04") !== 12) fail("release must restore the levels");
s.release("ghost");

threw = false;
try { s.reserve("mug-01", 1, "o5"); s.reserve("mug-01", 0, "o5"); } catch { threw = true; }
if (!threw) fail("qty 0 must throw");
threw = false;
try { s.freeLevel("nope-99"); } catch { threw = true; }
if (!threw) fail("unknown sku must throw");

console.log("PASS: reserve is atomic, orders are all-or-nothing");
