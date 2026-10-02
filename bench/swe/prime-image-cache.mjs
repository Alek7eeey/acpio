// One-off warmer for the image cache: pull every corpus instance image that
// has no cache tar yet and save it. Run when no rollout is using the images —
// it docker-rmi's each image after saving, so docker's own disk stays small
// and only the tar cache on the data drive grows.
//
//   node bench/swe/prime-image-cache.mjs            # the whole corpus
//   node bench/swe/prime-image-cache.mjs --concurrency 2
import { existsSync, readFileSync } from "node:fs";
import { runProcess } from "../lib/util.mjs";
import { cacheDir, cachePathFor, saveToCache } from "./image-cache.mjs";

const concurrency = (() => {
  const i = process.argv.indexOf("--concurrency");
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 1) : 2;
})();

const docker = (args, opts) => runProcess("docker", args, opts);

const corpus = readFileSync("bench/swe/corpus.txt", "utf8").trim().split("\n").filter(Boolean);
const imageFor = (id) => `swebench/sweb.eval.x86_64.${id}:latest`.toLowerCase().replace(/__/g, "_1776_");

if (!cacheDir()) {
  console.log("SWE_IMAGE_CACHE is off — nothing to prime");
  process.exit(0);
}

const todo = corpus.map(imageFor).filter((image) => !existsSync(cachePathFor(image)));
console.log(`priming ${todo.length}/${corpus.length} corpus images into ${cacheDir()} (concurrency ${concurrency})`);

let done = 0;
const failed = [];
const worker = async () => {
  for (;;) {
    const image = todo.shift();
    if (!image) return;
    let ok = true;
    try {
      const have = await docker(["image", "inspect", image], { timeoutMs: 30_000 });
      if (have.code !== 0) {
        const res = await docker(["pull", image], { timeoutMs: 1_800_000 });
        if (res.code !== 0) throw new Error(`pull failed: ${(res.stderr || res.stdout || "").slice(-200)}`);
      }
      await saveToCache(docker, image);
      // The tar is on the data drive — the local copy is dead weight. Only
      // safe because no rollout can be holding the image while this runs.
      const rmi = await docker(["rmi", image], { timeoutMs: 120_000 });
      ok = rmi.code === 0;
      if (!ok) failed.push(`${image}: rmi failed (image still in use?)`);
    } catch (err) {
      ok = false;
      failed.push(`${image}: ${err.message}`);
    }
    done += 1;
    console.log(`[${done}/${todo.length}] ${image}${ok ? "" : " FAILED"}`);
  }
};

await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const line of failed) console.log(`  ${line}`);
  process.exit(1);
}
console.log("cache primed");
