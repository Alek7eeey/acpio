// A local tar cache for the per-instance swebench eval images. Pulling a
// 1.5–3.5GB image from Docker Hub per instance made full-corpus runs spend
// more wall time downloading than the agents spent working; the cache turns
// a repeat pull into a local copy. One tar per image, flat directory.
//
//   SWE_IMAGE_CACHE=D:/swe-image-cache   where the tars live (default)
//   SWE_IMAGE_CACHE=off                  disable caching entirely
//
// Saving is best-effort: a failed save (disk full, drive missing) deletes the
// partial tar and the rollout continues — the cache never breaks a run.
import { existsSync, mkdirSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";

const DEFAULT_CACHE = "D:/swe-image-cache";
/** Below this many free bytes on the cache drive, stop saving new tars. */
const MIN_FREE_BYTES = 25 * 1024 * 1024 * 1024;

export const cacheDir = () => {
  const dir = process.env.SWE_IMAGE_CACHE ?? DEFAULT_CACHE;
  return dir === "off" || dir === "" ? null : dir;
};

/** Cache file for an image reference; the tag can't be a filename as is. */
export function cachePathFor(image) {
  const dir = cacheDir();
  if (!dir) return null;
  return path.join(dir, `${image.replace(/[^A-Za-z0-9._-]+/g, "_")}.tar`);
}

/** Load an image from the cache tar. Returns true on a cache hit. */
export async function loadFromCache(docker, image) {
  const file = cachePathFor(image);
  if (!file || !existsSync(file)) return false;
  console.log(`  loading ${image} from ${file}…`);
  const res = await docker(["load", "-i", file], { timeoutMs: 1_800_000 });
  if (res.code === 0) return true;
  // A broken entry would poison every later run — drop it and let the caller pull.
  console.log(`  cache load failed, falling back to pull: ${(res.stderr || res.stdout || "").slice(-200)}`);
  rmSync(file, { force: true });
  return false;
}

/** Save an image to the cache. Best-effort, never throws. */
export async function saveToCache(docker, image) {
  const file = cachePathFor(image);
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const free = statfsSync(path.dirname(file));
    if (free.bavail * free.bsize < MIN_FREE_BYTES) {
      console.log(`  image cache skipped: less than ${Math.round(MIN_FREE_BYTES / 1e9)}GB free on the cache drive`);
      return;
    }
    const res = await docker(["save", "-o", file, image], { timeoutMs: 1_800_000 });
    if (res.code !== 0) {
      console.log(`  image cache save failed: ${(res.stderr || res.stdout || "").slice(-200)}`);
      rmSync(file, { force: true });
    }
  } catch (err) {
    console.log(`  image cache skipped: ${err.message}`);
    rmSync(file, { force: true });
  }
}
