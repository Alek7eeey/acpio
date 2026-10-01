import { readFileSync } from "node:fs";
import { buildToc, slugifyHeading } from "./lib/toc.mjs";
import { parseHeadings } from "./lib/md-parse.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const md = readFileSync("content/sample.md", "utf8");
const expected = [
  "- [Release Notes](#release-notes)",
  "  - [Install](#install)",
  "  - [Install](#install-2)",
  "    - [Config](#config)",
  "      - [Deep](#deep)",
].join("\n");
const toc = buildToc(md);
if (toc !== expected) fail("toc mismatch:\n" + toc + "\n--- expected ---\n" + expected);
const headings = parseHeadings(md);
if (headings.length !== 5) fail("expected 5 headings, got " + headings.length + ": " + JSON.stringify(headings));
if (slugifyHeading("  Hello,  World! ") !== "hello-world") fail("slugifyHeading broken");
if (buildToc("") !== "") fail("empty document");
if (buildToc("# A\n# A\n# A").split("\n")[2] !== "- [A](#a-3)") fail("third duplicate must get -3");

console.log("PASS: toc skips fenced code and dedupes slugs");
