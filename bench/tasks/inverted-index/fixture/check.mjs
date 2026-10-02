import { readFileSync } from "node:fs";
import { createIndex } from "./lib/index.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const index = createIndex();
for (const line of readFileSync("data/corpus.tsv", "utf8").split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  index.addDocument(line.slice(0, tab), line.slice(tab + 1));
}

const phrase = index.phrase("error handling");
if (phrase.includes("d-phr-apart")) fail("the phrase matched a document where the words are chapters apart");
if (!phrase.includes("d-phr-adjacent")) fail("the phrase missed the adjacent document");
if (!index.searchAll("error", "handling").includes("d-phr-apart")) fail("AND search must still find co-occurrence");

console.log("PASS: phrase search requires adjacency");
