/**
 * Release tags as git knows them — the only source of the version (the rule itself
 * is scripts/versionHistory.mjs).
 *
 * Only tags reachable from the revision in question count: a tag sitting on an
 * unmerged branch is not released history for it, and a checkout of a tag must
 * derive that tag's number, not one above it.
 */
import { execFileSync } from "node:child_process";
import { compareVersions, nextVersion, parseReleaseVersion } from "./versionHistory.mjs";

/** Null when git cannot answer (outside a repository, no history). */
function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Release tags reachable from `rev`, newest first:
 * `[{ tag, version, day }]` with the tagged commit's author day (`YYYY-MM-DD`).
 */
export function readReleases(repoRoot, rev = "HEAD") {
  const listed = git(repoRoot, ["tag", "--list", "v*.*.*"]);
  if (listed === null) {
    throw new Error("Cannot read release tags: run this inside the git checkout.");
  }
  const head = git(repoRoot, ["rev-parse", `${rev}^{commit}`]);
  const releases = [];
  for (const tag of listed.split("\n").filter(Boolean)) {
    const version = parseReleaseVersion(tag);
    // `--is-ancestor` exits non-zero for a foreign tag, which git() reads as null.
    if (version === null || git(repoRoot, ["merge-base", "--is-ancestor", tag, rev]) === null) continue;
    releases.push({
      tag,
      version,
      day: git(repoRoot, ["log", "-1", "--format=%as", tag]),
      atRevision: git(repoRoot, ["rev-parse", `${tag}^{commit}`]) === head,
    });
  }
  return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * What this revision is released as: its own tag when it carries one, otherwise
 * one patch above the highest reachable release.
 *
 * `pendingCommit` is for the pre-commit hook, which runs before the commit exists:
 * the revision it stamps is the *next* commit, so the tag sitting on HEAD belongs
 * to released history and must not turn into "this revision's own tag". The hook
 * therefore stamps the number that commit will derive once it exists, which is
 * what keeps the working tree clean afterwards.
 */
export function deriveVersion(repoRoot, baseVersion, { rev = "HEAD", pendingCommit = false } = {}) {
  const releases = readReleases(repoRoot, rev);
  const own = pendingCommit ? null : releases.find((release) => release.atRevision);
  return {
    version: own ? own.version : nextVersion({ baseVersion, releases: releases.map((r) => r.version) }),
    releases,
    releasedTag: own?.tag ?? null,
  };
}
