import { normalizeKey } from "./lib/normalize.mjs";
import { DraftCache } from "./lib/draftcache.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (normalizeKey(" ./Docs//A/ ") !== "docs/a") fail("trim+case+slashes+trailing: " + JSON.stringify(normalizeKey(" ./Docs//A/ ")));
if (normalizeKey("/") !== "/") fail("the root stays itself");
if (normalizeKey("//") !== "/") fail("double root collapses to the root");
if (normalizeKey("") !== "") fail("empty string is a key");

const cache = new DraftCache();
cache.put("./Docs/A", { rev: 1 });
if (cache.get("docs/a/")?.rev !== 1) fail("read across equivalent spellings: " + JSON.stringify(cache.get("docs/a/")));
if (cache.get("./Docs/A")?.rev !== 1) fail("read with the original spelling");
if (!cache.has("DOCS//a")) fail("has agrees with get");
if (cache.size !== 1) fail("equivalent keys collapse: " + cache.size);

cache.put("docs/b", { rev: 2 });
if (cache.size !== 2) fail("distinct keys stay distinct");
if (cache.get("docs/b")?.rev !== 2) fail("plain spelling round-trips");
if (cache.get("docs/missing") !== undefined) fail("unknown key is undefined");

const root = new DraftCache();
root.put("/", "root-doc");
if (root.get("/") !== "root-doc") fail("the root path round-trips");

console.log("PASS: put and read share one normalized key");
