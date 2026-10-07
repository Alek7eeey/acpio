/**
 * Point this clone's git hooks at .githooks, so the version stamp runs inside
 * every commit (npm's `prepare` does it on install; `npm run hooks:install`
 * re-runs it). Quietly does nothing outside a git work tree or when
 * core.hooksPath already points somewhere else — an existing hook setup is never
 * overwritten.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_PATH = ".githooks";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function main() {
  if (gitOrNull(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    console.log("Not a git work tree — skipping the git hook install.");
    return;
  }
  const current = gitOrNull(["config", "--local", "--get", "core.hooksPath"]);
  if (current === HOOKS_PATH) {
    console.log(`Git hooks already at ${HOOKS_PATH}.`);
    return;
  }
  if (current) {
    console.warn(`core.hooksPath is "${current}" — leaving it alone; run \`npm run hooks:install\` after resetting it.`);
    return;
  }
  git(["config", "--local", "core.hooksPath", HOOKS_PATH]);
  console.log(`Git hooks installed: core.hooksPath=${HOOKS_PATH} (the version stamp runs on commit).`);
}

try {
  main();
} catch (error) {
  // A machine without git can still install dependencies and build.
  if (error?.code !== "ENOENT") throw error;
  console.log("git is not available — skipping the git hook install.");
}
