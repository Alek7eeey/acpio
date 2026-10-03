import { stripSuffix } from "./lib/trim.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

if (stripSuffix("a///", "/") !== "a//") fail("only one separator goes away: " + JSON.stringify(stripSuffix("a///", "/")));
if (stripSuffix("path/", "/") !== "path") fail("single trailing slash");
if (stripSuffix("/", "/") !== "") fail("text equal to the suffix becomes empty");
if (stripSuffix("abc", "x") !== "abc") fail("no match returns the input");
if (stripSuffix("", "/") !== "") fail("empty text stays empty");
if (stripSuffix("report.tar.gz", ".gz") !== "report.tar") fail("multi-char suffix");
if (stripSuffix("aaa", "aa") !== "a") fail("overlapping suffix strips once");

console.log("PASS: at most one trailing occurrence is removed");
