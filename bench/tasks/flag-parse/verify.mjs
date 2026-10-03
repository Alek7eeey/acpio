import { parseFlags } from "./lib/flags.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const f = parseFlags(["deploy", "--dry-run=false", "--verbose=true", "--quiet", "--tags=a,b,c", "--retries=3", "--label=live", "--flag=", "positional"]);
if (f["dry-run"] !== false) fail("dry-run=false must be the boolean false: " + JSON.stringify(f["dry-run"]));
if (f.verbose !== true) fail("verbose=true must be the boolean true");
if (f.quiet !== true) fail("bare --name must be the boolean true");
if (!eq(f.tags, ["a", "b", "c"])) fail("comma value must become an array");
if (f.retries !== 3) fail("numeric value must become a number: " + JSON.stringify(f.retries));
if (f.label !== "live") fail("plain value must stay a string: " + JSON.stringify(f.label));
if (f.flag !== "") fail("empty value is the empty string");
if (f.deploy !== undefined || f.positional !== undefined) fail("non-flag args are ignored");

console.log("PASS: booleans, arrays, numbers and strings coerce per the contract");
