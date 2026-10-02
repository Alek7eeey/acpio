import { createPlaylist } from "./lib/playlist.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const pl = createPlaylist();
pl.append("a").append("b").append("c").append("d");
if (pl.size !== 4 || pl.current !== "a") fail("append/current broken");
if (!eq(pl.toArray(), ["a", "b", "c", "d"]) || !eq(pl.toArrayReversed(), ["d", "c", "b", "a"])) fail("walks broken before any removal");
if (pl.next() !== "b" || pl.next() !== "c") fail("next walk broken");
if (pl.prev() !== "b" || pl.prev() !== "a") fail("prev walk broken");

if (!pl.remove("b")) fail("remove must find the track");
if (!eq(pl.toArray(), ["a", "c", "d"])) fail("forward chain broken after middle removal");
if (!eq(pl.toArrayReversed(), ["d", "c", "a"])) fail("backward chain severed by middle removal: " + JSON.stringify(pl.toArrayReversed()));
if (pl.next() !== "c") fail("next over the gap broken");
if (pl.prev() !== "a") fail("prev over the gap broken, got " + pl.prev());

if (!pl.remove("a")) fail("remove head");
if (!eq(pl.toArray(), ["c", "d"]) || !eq(pl.toArrayReversed(), ["d", "c"])) fail("head removal broken");
if (!pl.remove("d")) fail("remove tail");
if (!eq(pl.toArray(), ["c"]) || !eq(pl.toArrayReversed(), ["c"])) fail("tail removal broken");

if (pl.remove("ghost") !== false) fail("removing an unknown track must return false");
if (!pl.remove("c")) fail("remove last");
if (pl.size !== 0 || pl.current !== null || !eq(pl.toArray(), [])) fail("drain to empty broken");
pl.append("new");
if (pl.current !== "new" || !eq(pl.toArray(), ["new"])) fail("reuse after empty broken");

const sel = createPlaylist();
sel.append("1").append("2").append("3");
sel.next();
if (sel.current !== "2") fail("select second track");
if (!sel.remove("2")) fail("remove current");
if (sel.current !== "3") fail("removing the current track must select the next one");

console.log("PASS: removal reconnects both directions");
