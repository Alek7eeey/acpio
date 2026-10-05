// Hidden verifier for write-missing-tests.
//
// The deliverable is a test suite, so the verifier is a tiny mutation tester:
// the agent's test/roman.test.mjs must pass against the shipped lib and must
// FAIL against each of four spec-breaking mutants. A suite that still passes
// on a mutant is missing the clause that mutant violates.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const testFile = path.join(here, "test", "roman.test.mjs");
if (!existsSync(testFile)) fail("test/roman.test.mjs is missing");
const testSrc = readFileSync(testFile, "utf8");
if (!/node:test/.test(testSrc)) fail("the suite must use node:test");
if (!testSrc.includes("../lib/roman.mjs")) fail("the suite must import ../lib/roman.mjs");

const pristine = readFileSync(path.join(here, "lib", "roman.mjs"), "utf8");
if (!pristine.includes('n > 3999')) fail("lib/roman.mjs must not be modified");

const MUTANTS = [
  {
    name: "toRoman drops the XL pair (40 becomes XXXX)",
    src: (s) => s.replace(', [40, "XL"]', ""),
  },
  {
    name: "toRoman accepts 4000 (upper bound moved)",
    src: (s) => s.replace("n > 3999", "n > 4000"),
  },
  {
    name: "toArabic accepts lowercase (xiv parses instead of throwing)",
    src: (s) => s.replace('/^[MDCLXVI]+$/', '/^[MDCLXVI]+$/i'),
  },
  {
    name: "toArabic ignores subtractive pairs (MCMXCIV parses as 2216)",
    src: (s) => s.replace("total += v < next ? -v : v;", "total += v;"),
  },
];

function runSuite(libSrc, label) {
  const dir = path.join(os.tmpdir(), `wmt-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  mkdirSync(path.join(dir, "test"), { recursive: true });
  cpSync(testFile, path.join(dir, "test", "roman.test.mjs"));
  writeFileSync(path.join(dir, "lib", "roman.mjs"), libSrc);
  const res = spawnSync(process.execPath, ["test/roman.test.mjs"], { cwd: dir, timeoutMs: 30_000, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (res.error) fail(`${label}: the suite could not run (${res.error.message})`);
  return res.status;
}

if (runSuite(pristine, "pristine lib") !== 0) {
  fail("the suite must pass against the shipped lib/roman.mjs");
}
for (const m of MUTANTS) {
  const mutated = m.src(pristine);
  if (mutated === pristine) fail(`internal: mutant does not apply — ${m.name}`);
  if (runSuite(mutated, m.name) === 0) fail(`the suite still passes when ${m.name} — that clause is untested`);
}

console.log("PASS: the suite passes the spec and catches every planted regression");
