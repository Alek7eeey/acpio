import { GcHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new GcHeap();
const root = heap.allocate({ kind: "session" });
const cart = heap.allocate({ kind: "cart" });
const item = heap.allocate({ kind: "item" });
heap.link(root, cart);
heap.link(cart, item);
heap.addRoot(root);

if (heap.collect().length !== 0) fail("a rooted chain must lose nothing");
if (heap.get(item).kind !== "item") fail("the deep object must survive");

console.log("PASS: the rooted chain survives collection");
