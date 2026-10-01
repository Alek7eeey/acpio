// Downloads SWE-bench Verified (500 human-validated GitHub issues, Python repos)
// from HuggingFace and converts it to bench/swe/data/swe-bench-verified.jsonl.
//
//   node bench/swe/fetch-dataset.mjs
//
// The dataset is the SWE-bench org's current copy: unlike the original
// princeton-nlp upload it ships the per-instance docker `image` (the `_1776_`
// naming live on Docker Hub) and the self-contained `eval_script`, which is
// what the swebench 5.x package we grade with consumes. The parquet files are
// cached in bench/.cache/swe-bench/; the jsonl is the canonical local copy
// every SWE run reads.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE = path.join(REPO, "bench", ".cache", "swe-bench");
const OUT_DIR = path.join(REPO, "bench", "swe", "data");
const OUT = path.join(OUT_DIR, "swe-bench-verified.jsonl");
const DATASET = "SWE-bench/SWE-bench_Verified";

const py = (code, args = []) =>
  spawnSync("python3", ["-c", code, ...args], { encoding: "utf8", windowsHide: true });

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

const ensurePyarrow = () => {
  let r = py("import pyarrow");
  if (r.status === 0) return;
  console.log("pyarrow missing — installing (one-time)…");
  r = spawnSync("python3", ["-m", "pip", "install", "--quiet", "pyarrow"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error("pip install pyarrow failed");
};

async function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // The root /parquet endpoint answers with {config: {split: [urls…]}} —
  // Verified ships a single default/test file, but flatten whatever is there.
  const api = `https://huggingface.co/api/datasets/${DATASET}/parquet`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`HF parquet listing failed: ${res.status} ${await res.text()}`);
  const tree = await res.json();
  const urls = Object.values(tree).flatMap((splits) => Object.values(splits).flat());
  if (!urls.length) throw new Error("no parquet files listed");

  const files = [];
  for (const [i, url] of urls.entries()) {
    // Dataset name in the cache file name: two HF datasets share the shape
    // train-00000.parquet, and a stale cache would silently win.
    const dest = path.join(CACHE, `${DATASET.replace("/", "__")}-${String(i).padStart(5, "0")}.parquet`);
    if (!existsSync(dest) || statSync(dest).size === 0) {
      console.log(`downloading ${url}`);
      await download(url, dest);
    } else {
      console.log(`cached ${path.basename(dest)} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    }
    files.push(dest);
  }

  ensurePyarrow();
  const script = `
import json, sys
import pyarrow.parquet as pq

LIST_FIELDS = ("FAIL_TO_PASS", "PASS_TO_PASS", "test_directives")
out = open(sys.argv[1], "w", encoding="utf-8")
n = 0
for f in sys.argv[2:]:
    for row in pq.read_table(f).to_pylist():
        for k in LIST_FIELDS:
            v = row.get(k)
            if isinstance(v, str):
                try:
                    row[k] = json.loads(v)
                except Exception:
                    pass
        out.write(json.dumps(row, ensure_ascii=False) + "\\n")
        n += 1
out.close()
print(n)
`;
  const conv = py(script, [OUT, ...files]);
  if (conv.status !== 0) throw new Error(`parquet→jsonl failed: ${conv.stderr.slice(-500)}`);
  const count = Number(conv.stdout.trim());
  const sizeMb = (statSync(OUT).size / 1e6).toFixed(1);
  console.log(`\n${OUT}: ${count} instances (${sizeMb} MB)`);
  if (count !== 500) console.log(`⚠️ expected 500 instances in SWE-bench Verified, got ${count}`);

  // The runner needs image + eval_script (swebench 5.x dataset format). Missing
  // images are fine — run-swe.mjs derives them from instance_id — but a missing
  // eval_script cannot be worked around.
  const sampleAll = await fsp.readFile(OUT, "utf8");
  const rows = sampleAll.trim().split("\n").map((l) => JSON.parse(l));
  const noScript = rows.filter((r) => !r.eval_script).length;
  const noImage = rows.filter((r) => !r.image).length;
  if (noScript) console.log(`⚠️ ${noScript} instances have no eval_script — the dataset is not the swebench 5.x format`);
  if (noImage) console.log(`${noImage} instances have no image — run-swe.mjs will derive swebench/sweb.eval.x86_64.<id> names`);

  // A quick look at what we have, so the first run is not a surprise.
  const head = await fsp.readFile(OUT, "utf8").then((t) => JSON.parse(t.split("\n")[0]));
  console.log(`sample: ${head.instance_id} (${head.repo}, version ${head.version})`);
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
