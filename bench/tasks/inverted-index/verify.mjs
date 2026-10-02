import { readFileSync } from "node:fs";
import { createIndex } from "./lib/index.mjs";
import { tokenize } from "./lib/tokenize.mjs";

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const docs = new Map();
for (const line of readFileSync("data/corpus.tsv", "utf8").split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  docs.set(line.slice(0, tab), line.slice(tab + 1));
}
if (docs.size !== 604) fail("expected 604 documents, got " + docs.size);

const index = createIndex();
for (const [id, text] of docs) index.addDocument(id, text);

// independent recompute of the per-term posting lists
const expectedPostings = new Map(); // term -> Set(ids)
for (const [id, text] of docs) {
  for (const term of new Set(tokenize(text))) {
    let set = expectedPostings.get(term);
    if (!set) expectedPostings.set(term, (set = new Set()));
    set.add(id);
  }
}
for (const [term, ids] of expectedPostings) {
  if (!eq(index.search(term), [...ids].sort())) fail("posting list wrong for term " + term);
}
if (index.search("no-such-term-xyz").length !== 0) fail("unknown terms must return nothing");
if (index.searchAll().length !== 0) fail("searchAll with no terms must return nothing");
const withTerm = (term) => [...docs.keys()].filter((id) => tokenize(docs.get(id)).includes(term)).sort();
if (!eq(index.searchAll("error", "handling"), withTerm("error").filter((id) => withTerm("handling").includes(id)))) {
  fail("searchAll must be an AND over terms");
}

// independent phrase recompute: consecutive tokens in order
function docsMatchingPhrase(query) {
  const terms = tokenize(query);
  const out = [];
  for (const [id, text] of docs) {
    const tokens = tokenize(text);
    let ok = false;
    for (let i = 0; i + terms.length <= tokens.length; i++) {
      if (terms.every((t, k) => tokens[i + k] === t)) { ok = true; break; }
    }
    if (ok) out.push(id);
  }
  return out.sort();
}
if (!eq(index.phrase("error handling"), docsMatchingPhrase("error handling"))) fail("phrase 'error handling' set wrong");
if (!eq(index.phrase("handling error"), docsMatchingPhrase("handling error"))) fail("phrase 'handling error' set wrong");
if (index.phrase("error handling").includes("d-phr-apart")) fail("'error handling' must not match the chapters-apart document");
if (!index.phrase("error handling").includes("d-phr-adjacent")) fail("'error handling' must match the adjacent document");
if (index.phrase("handling error").includes("d-phr-apart")) fail("'handling error' must not match a non-adjacent document");
if (!eq(index.phrase("so so"), ["d-phr-repeat"])) fail("a repeated-term phrase must need true adjacency: " + JSON.stringify(index.phrase("so so")));
if (index.phrase("!!!").length !== 0) fail("a phrase with no terms must return nothing");

index.removeDocument("d-phr-adjacent");
if (index.search("outage").includes("d-phr-adjacent")) fail("removeDocument must forget the document");
if (index.phrase("error handling").includes("d-phr-adjacent")) fail("a removed document must leave every phrase set");
index.addDocument("d-phr-adjacent", docs.get("d-phr-adjacent"));
if (!index.search("outage").includes("d-phr-adjacent")) fail("re-adding must restore the document");

const before = index.search("deploy");
index.addDocument("d-0001", docs.get("d-0001"));
if (!eq(index.search("deploy"), before)) fail("re-adding the same text must not duplicate postings");
index.addDocument("d-0001", "wholly different words now");
if (index.search("deploy").includes("d-0001")) fail("re-adding must replace the old terms");
if (!index.search("wholly").includes("d-0001")) fail("re-adding must index the new terms");

console.log("PASS: positions drive phrase search; postings, AND and removal match");
