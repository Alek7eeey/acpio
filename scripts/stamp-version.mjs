/**
 * Commit-time version stamp, run by the pre-commit hook (.githooks/pre-commit).
 *
 * The version is derived from git history (one patch per commit day), so nothing
 * has to be bumped by hand: this refreshes the stamp and stages it, and the commit
 * being created carries its own version. `git commit --no-verify` skips it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION_STAMP_FILES } from "./versionHistory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** What the index (i.e. the commit about to be created) holds for a path, or null when untracked. */
function indexedContent(file) {
  try {
    return git(["show", `:${file}`]);
  } catch {
    return null;
  }
}

/** Line endings are git's business (core.autocrlf), not a reason to restamp. */
function normalize(text) {
  return text === null ? null : text.replace(/\r\n/g, "\n");
}

execFileSync(process.execPath, [path.join(repoRoot, "scripts", "generate-version.mjs"), "--pending-commit"], {
  cwd: repoRoot,
  stdio: "inherit",
});

const stale = VERSION_STAMP_FILES.filter((file) => {
  const abs = path.join(repoRoot, file);
  return fs.existsSync(abs) && normalize(fs.readFileSync(abs, "utf8")) !== normalize(indexedContent(file));
});

if (stale.length === 0) {
  console.log("Version stamp already in the index — nothing to add.");
} else {
  git(["add", "--", ...stale]);
  console.log(`Version stamp staged into this commit: ${stale.join(", ")}`);
}
