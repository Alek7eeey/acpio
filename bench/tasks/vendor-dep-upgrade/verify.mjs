// Hidden verifier for vendor-dep-upgrade.
// Contract: src imports the v2 vendored module, vendor/ is untouched, and
// every current output of src/normalize.mjs is byte-identical — including
// the cases where v2's toKebab would have changed them.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const srcDir = path.join(here, "src");
let sawV1 = false;
let sawV2 = false;
for (const f of readdirSync(srcDir)) {
  if (!f.endsWith(".mjs")) continue;
  const text = readFileSync(path.join(srcDir, f), "utf8");
  if (text.includes("vendor/stringcase/index.mjs")) sawV1 = true;
  if (text.includes("vendor/stringcase-v2")) sawV2 = true;
}
if (sawV1) fail("src still imports the v1 vendored module");
if (!sawV2) fail("src does not import vendor/stringcase-v2");

// vendor/ untouched: v2 must still show its documented v2 semantics, v1 its v1 ones.
const v2 = await import(pathToFileURL(path.join(here, "vendor", "stringcase-v2", "index.mjs")).href);
if (v2.toKebab("backgroundColor") !== "background-color" || v2.toKebab("HTTPStatus") !== "http-status") {
  fail("vendor/stringcase-v2 was modified — vendor/ is frozen");
}
if (v2.camelCase("HTTP status", { preserveFirst: true }) !== "HTTPStatus") {
  fail("vendor/stringcase-v2 was modified — vendor/ is frozen");
}
const v1 = await import(pathToFileURL(path.join(here, "vendor", "stringcase", "index.mjs")).href);
if (typeof v1.kebabCase !== "function") fail("vendor/stringcase (v1) was modified — vendor/ is frozen");

const app = await import(pathToFileURL(path.join(srcDir, "normalize.mjs")).href);
const CASES = [
  ["fieldName", "HTTP-status-code", "HTTPStatusCode"],
  ["fieldName", "user name", "userName"],
  ["fieldName", "id", "id"],
  ["fieldName", "", ""],
  ["fieldName", "parse HTTP response", "parseHttpResponse"],
  ["slug", "HTTPStatus", "httpstatus"],
  ["slug", "Hello World", "hello-world"],
  ["slug", "Foo Bar Baz", "foo-bar-baz"],
  ["slug", "", ""],
  ["cssVar", "backgroundColor", "--backgroundcolor"],
  ["cssVar", "Content-Type", "--content-type"],
  ["cssVar", "WebHookURL", "--webhookurl"],
];
for (const [fn, input, expected] of CASES) {
  const got = app[fn](input);
  if (got !== expected) fail(`${fn}(${JSON.stringify(input)}) = ${JSON.stringify(got)}, the app's contract is ${JSON.stringify(expected)}`);
}

console.log("PASS: src is on v2, vendor untouched, every output byte-identical");
