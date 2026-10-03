import { assertTransition } from "./lib/states.mjs";
import { applyEvent, applyAll } from "./lib/service.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const throws = (fn, what) => {
  try {
    fn();
  } catch {
    return;
  }
  fail("must throw: " + what);
};

const happy = applyAll({ state: "draft", total: 100 }, [
  { type: "place" },
  { type: "pay" },
  { type: "ship" },
  { type: "deliver" },
]);
if (happy.state !== "delivered") fail("happy path ends delivered");
if (happy.refunded !== undefined) fail("no refund on the happy path");

const refunded = applyAll({ state: "draft", total: 250 }, [{ type: "place" }, { type: "pay" }, { type: "refund" }]);
if (refunded.state !== "refunded" || refunded.refunded !== 250) fail("refund ledger");

throws(() => applyEvent(refunded, { type: "ship" }), "refunded -> shipped must throw");
if (refunded.state !== "refunded" || refunded.refunded !== 250) fail("a thrown move leaves the order untouched");

const placed = { state: "placed", total: 10 };
throws(() => applyEvent(placed, { type: "place" }), "repeat of the current state is not in the table");
throws(() => applyEvent({ state: "draft", total: 1 }, { type: "pay" }), "draft -> pay");
throws(() => applyEvent({ state: "delivered", total: 1 }, { type: "cancel" }), "delivered is terminal");
throws(() => applyEvent({ state: "paid", total: 1 }, { type: "explode" }), "unknown event");
assertTransition("paid", "shipped"); // legal pair must not throw

const cancelled = applyEvent({ state: "placed", total: 5 }, { type: "cancel" });
if (cancelled.state !== "cancelled") fail("cancel path works");

console.log("PASS: unlisted transitions throw, the ledger stays truthful");
