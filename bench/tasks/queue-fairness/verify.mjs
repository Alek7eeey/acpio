import { TwoQueueScheduler } from "./lib/scheduler.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const s = new TwoQueueScheduler();
s.pushA("a1").pushA("a2").pushA("a3").pushB("b1").pushB("b2");
const order = s.drain((task, side) => side + ":" + task);
if (!eq(order, ["A:a1", "B:b1", "A:a2", "B:b2", "A:a3"])) {
  fail("both queues must interleave: " + JSON.stringify(order));
}

const onlyA = new TwoQueueScheduler().pushA("x").pushA("y");
if (!eq(onlyA.drain((t) => t), ["x", "y"])) fail("single side drains in order");

const tail = new TwoQueueScheduler().pushA("a").pushB("b1").pushB("b2").pushB("b3");
if (!eq(tail.drain((t) => t), ["a", "b1", "b2", "b3"])) fail("after A runs dry B drains in order");

const empty = new TwoQueueScheduler();
if (!eq(empty.drain(() => 1), [])) fail("both empty drains nothing");

console.log("PASS: the scheduler alternates between queues, no starvation");
