#!/usr/bin/env node
// clip — trim long text to a width. Documented in README.md; the README is
// the contract and this implementation must match it.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let width = null;
let at = "char";
let marker = "…";
let text = null;
let file = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--width") width = Number(argv[++i]);
  else if (a === "--at") at = argv[++i];
  else if (a === "--marker") marker = argv[++i];
  else if (a.startsWith("@")) file = a.slice(1);
  else text = a;
}
const usage = 'usage: node clip.js <text | @file> --width N [--at word|char] [--marker "..."]';
if (width === null || !Number.isFinite(width) || width < 1 || (text === null && file === null) || !["word", "char"].includes(at)) {
  console.error(usage);
  process.exit(1);
}
if (file !== null) text = readFileSync(file, "utf8").replace(/\r?\n$/, "");

if (text.length <= width) {
  console.log(text);
  process.exit(0);
}
const budget = Math.max(0, width - marker.length);
let body;
if (at === "word") {
  body = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const cand = body ? `${body} ${w}` : w;
    if (cand.length > budget) break;
    body = cand;
  }
} else {
  body = text.slice(0, budget).replace(/\s+$/, "");
}
console.log(body + marker);
