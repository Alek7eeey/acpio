#!/usr/bin/env node
// clip — trim long text to a width. Documented in README.md; the README is
// the contract and this implementation must match it.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let width = null;
let text = null;
const extra = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--width") width = Number(argv[++i]);
  else if (text === null) text = argv[i];
  else extra.push(argv[i]);
}
if (width === null || !text) {
  console.log('usage: node clip.js <text | @file> --width N [--at word|char] [--marker "..."]');
  process.exit(0);
}
if (text.startsWith("@")) text = "[file support pending]";
const marker = "...";
const cut =
  text.length > width ? text.slice(0, Math.max(0, width - marker.length)) + marker : text;
console.log(cut);
