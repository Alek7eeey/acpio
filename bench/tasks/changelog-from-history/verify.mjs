// Hidden verifier for changelog-from-history.
// The prompt pins the exact format a release bot parses: version headers
// newest-first with tag dates, sections per type, one bullet per entry with
// its (#NNN), BREAKING callout on the one flagged entry, nothing invented.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const file = path.join(here, "CHANGELOG.md");
if (!existsSync(file)) fail("CHANGELOG.md is missing");
const text = readFileSync(file, "utf8");
if (!/^#\s+Changelog\s*$/m.test(text)) fail("the `# Changelog` title line is missing");

// Parse versions -> sections -> bullets.
const versions = [];
for (const line of text.split(/\r?\n/)) {
  const v = line.match(/^##\s+(Unreleased|v\d+\.\d+\.\d+)\s*(.*)$/);
  if (v) versions.push({ name: v[1], tail: v[2], sections: {}, order: [] });
  else if (/^###\s+/.test(line) && versions.length) {
    versions[versions.length - 1].order.push(line.replace(/^###\s+/, "").trim());
    versions[versions.length - 1].sections[line.replace(/^###\s+/, "").trim()] = [];
  } else if (/^-\s+/.test(line) && versions.length) {
    const cur = versions[versions.length - 1];
    cur.sections[cur.order[cur.order.length - 1]]?.push(line.replace(/^-\s+/, "").trim());
  }
}

const byName = Object.fromEntries(versions.map((v) => [v.name, v]));
const order = versions.map((v) => v.name);
const expectedOrder = ["Unreleased", "v1.4.0", "v1.3.0"];
for (const name of expectedOrder) {
  if (!byName[name]) fail(`the ${name} version header is missing`);
}
if (JSON.stringify(order) !== JSON.stringify(expectedOrder)) {
  fail(`versions must appear newest first: Unreleased, v1.4.0, v1.3.0 — got ${order.join(", ")}`);
}
if (!/2026-09-28/.test(byName["v1.4.0"].tail)) fail("v1.4.0 must carry its tag date 2026-09-28");
if (!/2026-08-30/.test(byName["v1.3.0"].tail)) fail("v1.3.0 must carry its tag date 2026-08-30");
if (/\d{4}-\d{2}-\d{2}/.test(byName.Unreleased.tail)) fail("Unreleased must not carry a date");

// name -> [PR ref, section, mustStartWithBreaking]
const ENTRIES = [
  ["#138", "v1.4.0", "Fixed", false],
  ["#140", "v1.4.0", "Added", false],
  ["#141", "v1.4.0", "Fixed", false],
  ["#144", "v1.4.0", "Changed", true],
  ["#147", "v1.4.0", "Performance", false],
  ["#149", "v1.4.0", "Fixed", false],
  ["#151", "v1.4.0", "Docs", false],
  ["#153", "Unreleased", "Added", false],
  ["#155", "Unreleased", "Fixed", false],
  ["#156", "Unreleased", "Fixed", false],
];
const seenRefs = [];
for (const [ref, ver, section, breaking] of ENTRIES) {
  const v = byName[ver];
  const bullets = v.sections[section] ?? [];
  const hit = bullets.find((b) => b.includes(`(${ref})`));
  if (!hit) fail(`${ref} must be a bullet under ${ver} -> ${section}`);
  seenRefs.push(ref);
  if (breaking && !/^\*\*BREAKING:\*\*/.test(hit)) fail(`${ref} is the BREAKING change — its bullet must start with **BREAKING:**`);
  if (!breaking && /^\*\*BREAKING:\*\*/.test(hit)) fail(`${ref} is not flagged BREAKING in HISTORY.txt`);
}
const allBullets = versions.flatMap((v) => Object.values(v.sections).flat());
if (allBullets.length !== ENTRIES.length) {
  fail(`expected exactly ${ENTRIES.length} bullets, found ${allBullets.length} — do not invent or drop entries`);
}
const dup = seenRefs.find((r, i) => seenRefs.indexOf(r) !== i);
if (dup) fail(`${dup} appears more than once`);

console.log("PASS: changelog matches the release format, every entry in place");
