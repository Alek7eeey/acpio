/**
 * Release notes for one version: what changed since the previous release tag,
 * plus whatever the maintainer chose to say about it.
 *
 * Written to stdout, so the release job redirects it into `gh release create
 * --notes-file`. A release is a tag (see versionHistory.mjs), so notes are keyed
 * by tag rather than kept in a changelog file: the tag is what a release is.
 *
 * Usage: node scripts/release-notes.mjs --version 0.1.39 [--extra "text"] [--extra-file f]
 *
 * The free-form part, when not passed, comes from the annotated tag `v<version>`
 * — an annotated tag is the natural place to say what a release is about
 * (`git tag -a v0.1.39 -m "…"`), and a lightweight tag simply has nothing to add.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "./versionHistory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? "");
}

/**
 * Null when git cannot answer (no tags yet, not a repository) — notes are
 * best-effort. Arguments go to git verbatim: this file used a command string,
 * and on the Linux release runner the shell expanded the `v*.*.*` tag pattern
 * into the repo's own `vitest.config.ts`, so git listed no tags at all and the
 * release body quietly fell back to the last 30 commits. No shell, no patterns
 * for it to eat.
 */
function git(args) {
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

const version = arg("--version");
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs --version <version> [--extra <text>] [--extra-file <file>]");
  process.exit(1);
}
const tag = `v${version}`;

const extraFile = arg("--extra-file");
const extra = (
  arg("--extra") ??
  (extraFile && fs.existsSync(extraFile) ? fs.readFileSync(extraFile, "utf8") : "") ??
  ""
).trim();

/** Free-form text: the maintainer's input, else the message of an *annotated* tag. */
function tagMessage() {
  if (git(["cat-file", "-t", tag]) !== "tag") return "";
  return (git(["tag", "-l", "--format=%(contents)", tag]) ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The last released version *below* this one — the commits it is missing. Both
 * conditions matter: reachable from HEAD (a tag on an unmerged branch is not
 * released history) and lower than the version being noted (notes for an older
 * release must not start from a newer tag).
 */
function previousTag() {
  const tags = (git(["tag", "--list", "v*.*.*", "--sort=-v:refname"]) ?? "").split("\n").filter(Boolean);
  return (
    tags.find(
      (candidate) =>
        candidate !== tag &&
        compareVersions(candidate.replace(/^v/, ""), version) < 0 &&
        git(["merge-base", "--is-ancestor", candidate, "HEAD"]) !== null,
    ) ?? null
  );
}

/**
 * Commits here read "Statement: the reasoning behind it" — the head is the
 * release-notes-sized version of it, the whole subject a paragraph. Use the head
 * when the subject is long enough to have one, so a release note stays skimmable
 * without hiding anything (the full message is one click away in the history).
 */
function oneLine(subject) {
  const colon = subject.indexOf(": ");
  if (subject.length > 90 && colon >= 25) return subject.slice(0, colon);
  return subject;
}

const previous = previousTag();
if (previous === null) {
  // Loud on purpose: a release with tags in history but no previous release found
  // means the notes below are the fallback, not "what changed since last time".
  console.error(`release-notes: no previous release tag found above HEAD for ${tag} — listing the last commits.`);
}
const subjects = (
  git(previous ? ["log", `${previous}..HEAD`, "--format=%s"] : ["log", "-n", "30", "--format=%s"]) ?? ""
)
  .split("\n")
  .filter(Boolean)
  .map(oneLine);

const body = [extra.trim() || tagMessage()].filter(Boolean).join("\n\n");
const lines = [`## acpio ${version}`];
if (body) lines.push("", body);
lines.push("", previous ? `### Commits since ${previous}` : "### Commits");
if (subjects.length === 0) lines.push("", "- (nothing new)");
else lines.push("", ...subjects.map((subject) => `- ${subject}`));

console.log(lines.join("\n") + "\n");
