#!/usr/bin/env node
// Deterministic selector for the SWE-bench Verified corpus. The corpus is
// what this script prints — re-running it must always yield the same 100
// instances, so iterations compare the same tasks over time.
//
//   node bench/swe/select-corpus.mjs           # summary + all 100 ids
//   node bench/swe/select-corpus.mjs --line    # the --instances value only
//   node bench/swe/select-corpus.mjs --new     # only the 60 not yet run
//   node bench/swe/select-corpus.mjs --write   # also save bench/swe/corpus.txt
//
// Rule: django/sympy stay out (owner decision), the 40 already in the corpus
// (EVER_RUN + WAVE2 below) are kept as is, and 60 more are picked in cost
// tiers — cheapest eval first: the eval script only runs the listed
// FAIL_TO_PASS/PASS_TO_PASS tests, so those counts bound eval time. Within a
// tier, repos are interleaved round-robin (fewest picks first, repo name as
// tie-break) and candidates sort by (PASS_TO_PASS, id) inside a repo.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(HERE, "data", "swe-bench-verified.jsonl");

// The 2026-09-30 corpus the iterations ran (see the ledger in bench/results).
const EVER_RUN = [
  "pallets__flask-5014", "psf__requests-1142", "psf__requests-2931", "psf__requests-5414",
  "pylint-dev__pylint-4551", "pylint-dev__pylint-4661", "pylint-dev__pylint-4970",
  "pylint-dev__pylint-6386", "pylint-dev__pylint-7080", "pylint-dev__pylint-8898",
  "pytest-dev__pytest-10051", "pytest-dev__pytest-10081", "pytest-dev__pytest-10356",
  "pytest-dev__pytest-5631", "pytest-dev__pytest-5809", "pytest-dev__pytest-6202",
  "pytest-dev__pytest-7432", "pytest-dev__pytest-7571", "pytest-dev__pytest-7982",
  "pytest-dev__pytest-8399",
];
// The 2026-10-01 +20 expansion (gold self-test 5/5, stamp 2026-10-01T20-10-08-178Z).
const WAVE2 = [
  "astropy__astropy-7671", "astropy__astropy-7166", "astropy__astropy-14365",
  "astropy__astropy-13453", "astropy__astropy-14182", "matplotlib__matplotlib-24637",
  "pylint-dev__pylint-6903", "pydata__xarray-3677", "scikit-learn__scikit-learn-14141",
  "scikit-learn__scikit-learn-14053", "scikit-learn__scikit-learn-13328",
  "scikit-learn__scikit-learn-25747", "scikit-learn__scikit-learn-10844",
  "sphinx-doc__sphinx-8595", "sphinx-doc__sphinx-9711", "sphinx-doc__sphinx-8035",
  "sphinx-doc__sphinx-8721", "sphinx-doc__sphinx-10614", "sphinx-doc__sphinx-7889",
  "sphinx-doc__sphinx-10466",
];

const TARGET = 100;
const NEW_NEEDED = TARGET - EVER_RUN.length - WAVE2.length;

const TIERS = [
  ["T1  FTP=1,  PTP<=30", (ftp, ptp) => ftp === 1 && ptp <= 30],
  ["T2  FTP=1,  PTP<=60", (ftp, ptp) => ftp === 1 && ptp <= 60],
  ["T3  FTP<=2, PTP<=60", (ftp, ptp) => ftp <= 2 && ptp <= 60],
  ["T4  FTP<=3, PTP<=100", (ftp, ptp) => ftp <= 3 && ptp <= 100],
  ["T5  FTP<=5, PTP<=150", (ftp, ptp) => ftp <= 5 && ptp <= 150],
];

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const out = JSON.parse(v);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
};

const rows = readFileSync(DATASET, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map(rows.map((r) => [r.instance_id, r]));
for (const id of [...EVER_RUN, ...WAVE2]) {
  if (!byId.has(id)) throw new Error(`fixed corpus id not in dataset: ${id}`);
}

const fixed = new Set([...EVER_RUN, ...WAVE2]);
const pool = rows
  .filter((r) => !fixed.has(r.instance_id) && r.repo !== "django/django" && r.repo !== "sympy/sympy")
  .map((r) => ({ id: r.instance_id, repo: r.repo, ftp: parseList(r.FAIL_TO_PASS).length, ptp: parseList(r.PASS_TO_PASS).length, difficulty: r.difficulty }));

const picked = [];
const tierOf = new Map();
for (const [name, pred] of TIERS) {
  if (picked.length >= NEW_NEEDED) break;
  const tier = pool.filter((r) => !tierOf.has(r.id) && pred(r.ftp, r.ptp));
  const byRepo = new Map();
  for (const r of tier) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  for (const list of byRepo.values()) list.sort((a, b) => a.ptp - b.ptp || a.id.localeCompare(b.id));
  while (picked.length < NEW_NEEDED && byRepo.size > 0) {
    let repo = null;
    for (const [name2, list] of byRepo) {
      if (list.length === 0) continue;
      if (repo === null || byRepo.get(repo).length > list.length || (byRepo.get(repo).length === list.length && name2 < repo)) repo = name2;
    }
    if (repo === null) break;
    picked.push(byRepo.get(repo).shift());
    tierOf.set(picked[picked.length - 1].id, name);
    if (byRepo.get(repo).length === 0) byRepo.delete(repo);
  }
}
if (picked.length < NEW_NEEDED) throw new Error(`tiers exhausted: ${picked.length} of ${NEW_NEEDED}`);

const all = [...EVER_RUN, ...WAVE2, ...picked.map((r) => r.id)];

if (process.argv.includes("--line")) {
  console.log(all.join(","));
} else if (process.argv.includes("--new")) {
  console.log(picked.map((r) => r.id).join(","));
} else {
  const sum = (list) => list.reduce((acc, id) => {
    const r = byId.get(id);
    acc.ftp += parseList(r.FAIL_TO_PASS).length;
    acc.ptp += parseList(r.PASS_TO_PASS).length;
    acc.diff[r.difficulty] = (acc.diff[r.difficulty] ?? 0) + 1;
    return acc;
  }, { ftp: 0, ptp: 0, diff: {} });
  const stat = sum(all);
  const newStat = sum(picked.map((r) => r.id));

  console.log(`corpus: ${all.length} instances (${EVER_RUN.length} ever run + ${WAVE2.length} wave 2 + ${picked.length} new)`);
  console.log(`totals: FAIL_TO_PASS ${stat.ftp}, PASS_TO_PASS ${stat.ptp}, difficulty ${JSON.stringify(stat.diff)}`);
  console.log(`new 60: FAIL_TO_PASS ${newStat.ftp}, PASS_TO_PASS ${newStat.ptp}, difficulty ${JSON.stringify(newStat.diff)}`);
  const byRepo = {};
  for (const r of picked) byRepo[r.repo] = (byRepo[r.repo] ?? 0) + 1;
  console.log("new 60 by repo: " + JSON.stringify(byRepo));
  const byTier = {};
  for (const r of picked) byTier[tierOf.get(r.id)] = (byTier[tierOf.get(r.id)] ?? 0) + 1;
  console.log("new 60 by tier: " + JSON.stringify(byTier, null, 0));
  console.log("\n-- new 60 --");
  for (const r of picked) console.log(`${tierOf.get(r.id)}  ${r.id}  ftp=${r.ftp} ptp=${r.ptp}  ${r.difficulty}`);
  console.log("\n-- full corpus (--instances value) --");
  console.log(all.join(","));
}

if (process.argv.includes("--write")) {
  writeFileSync(path.join(HERE, "corpus.txt"), all.join("\n") + "\n");
  console.error(`written: ${path.join(HERE, "corpus.txt")}`);
}
