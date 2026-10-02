import { GcHeap } from "./lib/heap.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const heap = new GcHeap();
const root = heap.allocate({ kind: "session" });
const cart = heap.allocate({ kind: "cart" });
const item = heap.allocate({ kind: "item" });
const junk1 = heap.allocate({ kind: "junk1" });
const junk2 = heap.allocate({ kind: "junk2" });
heap.link(root, cart);
heap.link(cart, item);
heap.addRoot(root);

let freed = heap.collect();
if (freed.join(",") !== "o4,o5") fail("collect must free exactly the unrooted objects: " + freed.join(","));
if (heap.get(item).kind !== "item") fail("the deep object must survive");
let threw = false;
try { heap.get(junk1); } catch { threw = true; }
if (!threw) fail("a freed id must throw");

heap.removeRoot(root);
freed = heap.collect();
if (freed.join(",") !== "o1,o2,o3") fail("the unrooted chain must be collected in numeric order: " + freed.join(","));
threw = false;
try { heap.get(item); } catch { threw = true; }
if (!threw) fail("a freed id must throw");
threw = false;
try { heap.addRoot("o1"); } catch { threw = true; }
if (!threw) fail("addRoot of a freed id must throw");

const h2 = new GcHeap();
const a = h2.allocate({ n: "a" });
const b = h2.allocate({ n: "b" });
h2.link(a, b);
h2.link(b, a);
h2.addRoot(a);
const c = h2.allocate({ n: "c" });
freed = h2.collect();
if (freed.join(",") !== c) fail("a rooted cycle must survive, freed " + freed.join(","));
if (h2.get(b).n !== "b") fail("a cycle member must survive");
h2.removeRoot(a);
freed = h2.collect();
if (freed.length !== 2) fail("the unrooted cycle must be collected: " + freed.join(","));

const h3 = new GcHeap();
const shared = h3.allocate({ s: 1 });
const r1 = h3.allocate({}, [shared]);
const r2 = h3.allocate({}, [shared]);
h3.addRoot(r1);
h3.addRoot(r2);
if (h3.collect().length !== 0) fail("an object behind two roots must survive once, not be double-freed");

const h4 = new GcHeap();
const garbage = [];
for (let i = 0; i < 12; i++) garbage.push(h4.allocate({ i }));
const swept = h4.collect();
if (swept.join(",") !== "o1,o2,o3,o4,o5,o6,o7,o8,o9,o10,o11,o12") fail("freed ids must ascend numerically: " + swept.join(","));
const fresh = h4.allocate({ fresh: true });
if (fresh !== "o13" || swept.includes(fresh)) fail("ids must never be reused after a collect");
if (h4.get(fresh).fresh !== true) fail("the fresh allocation must be readable");

console.log("PASS: marking follows every chain; sweeping frees exactly the rest");
