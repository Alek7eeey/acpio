import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version stamping at commit time (scripts/stamp-version.mjs, driven by the
 * pre-commit hook; the number itself comes from scripts/releaseTags.mjs).
 *
 * The version follows the release tags, so an ordinary commit has nothing to
 * restamp. What the hook is for: a checkout that learned about a release — a
 * `git pull` fetching the tag the release run pushed — carries that bump into its
 * next commit instead of leaving the working tree dirty.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP_FILES = ["README.md", "readme-ru.md", "VERSIONS.md", "packages/shared/src/buildInfo.ts"];
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function dayKey(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayLabel(key) {
  const [year, month, day] = key.split("-");
  return `${day}.${month}.${year.slice(2)}`;
}

function git(cwd, args, { env } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(cwd, message, { date, verify = true } = {}) {
  const stamp = `${date}T12:00:00`;
  const args = ["commit", "-q", "-m", message];
  if (!verify) args.push("--no-verify");
  return git(cwd, args, { env: date ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : undefined });
}

function node(cwd, script, args = []) {
  return execFileSync(process.execPath, [path.join(cwd, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function headFile(cwd, file) {
  return git(cwd, ["show", `HEAD:${file}`]);
}

function headFiles(cwd) {
  return git(cwd, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
}

function status(cwd) {
  return git(cwd, ["status", "--porcelain"]);
}

/** Fixture: 0.1.0 released two days ago, its restamp committed yesterday. */
function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-stamp-"));
  tempDirs.push(dir);
  fs.cpSync(path.join(repoRoot, "scripts"), path.join(dir, "scripts"), { recursive: true });
  if (fs.existsSync(path.join(repoRoot, ".githooks"))) {
    fs.cpSync(path.join(repoRoot, ".githooks"), path.join(dir, ".githooks"), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "packages", "shared", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "stamp-fixture", private: true, version: "0.1.0" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Fixture\n\n**Current version:** 0.1.0\n");
  fs.writeFileSync(path.join(dir, "readme-ru.md"), "# Fixture\n\n**Актуальная версия:** 0.1.0\n");

  git(dir, ["-c", "init.defaultBranch=main", "init", "-q"]);
  git(dir, ["config", "user.name", "Stamp Fixture"]);
  git(dir, ["config", "user.email", "stamp@fixture.test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  git(dir, ["add", "-A"]);
  commit(dir, "Fixture start", { date: dayKey(-2), verify: false });
  git(dir, ["tag", "v0.1.0"]); // the first release
  fs.writeFileSync(path.join(dir, "work.txt"), "later work\n");
  git(dir, ["add", "-A"]);
  commit(dir, "Work after the release", { date: dayKey(-1), verify: false });
  node(dir, "generate-version.mjs");
  git(dir, ["add", "-A"]);
  commit(dir, "Stamp the fixture", { date: dayKey(-1), verify: false });
  return dir;
}

function writeAndStage(dir, content) {
  fs.writeFileSync(path.join(dir, "work.txt"), content);
  git(dir, ["add", "-A"]);
}

describe("version stamping at commit time", () => {
  it("stamps the number next after the last release", () => {
    const dir = createFixture();
    expect(headFile(dir, "README.md")).toContain("**Current version:** 0.1.1");
    expect(headFile(dir, "packages/shared/src/buildInfo.ts")).toContain('"version": "0.1.1"');
    expect(headFile(dir, "VERSIONS.md")).toContain(`| 0.1.0 | ${dayLabel(dayKey(-2))} |`);
  });

  it("reports its own tag on the revision that was released", () => {
    const dir = createFixture();
    git(dir, ["tag", "v0.1.1"]);
    expect(node(dir, "generate-version.mjs")).toContain("Version: 0.1.1 (released as v0.1.1)");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("**Current version:** 0.1.1");
  });

  it("leaves the stamp alone when git runs without the hook", () => {
    const dir = createFixture();
    writeAndStage(dir, "today, no hooks\n");
    commit(dir, "A commit git makes on its own");

    expect(headFile(dir, "README.md")).toContain("**Current version:** 0.1.1");
    expect(headFiles(dir)).not.toContain("VERSIONS.md");
  });

  it("carries a pulled release into the next commit when the hook is installed", () => {
    const dir = createFixture();
    node(dir, "install-git-hooks.mjs");
    expect(git(dir, ["config", "--get", "core.hooksPath"])).toBe(".githooks");

    // What `git pull` brings after a release run: the tag, on an untagged commit.
    git(dir, ["tag", "v0.1.1"]);
    writeAndStage(dir, "today, with the hook\n");
    commit(dir, "Commit after the release");

    const changed = headFiles(dir);
    for (const file of STAMP_FILES) expect(changed).toContain(file);
    expect(headFile(dir, "README.md")).toContain("**Current version:** 0.1.2");
    expect(headFile(dir, "readme-ru.md")).toContain("**Актуальная версия:** 0.1.2");
    expect(headFile(dir, "packages/shared/src/buildInfo.ts")).toContain('"version": "0.1.2"');
    expect(headFile(dir, "VERSIONS.md")).toContain(`| 0.1.1 | ${dayLabel(dayKey(-1))} |`);
    expect(headFile(dir, "VERSIONS.md")).toContain(`| 0.1.0 | ${dayLabel(dayKey(-2))} |`);

    // Nothing is left dangling: the build-time derivation agrees with the commit.
    node(dir, "generate-version.mjs");
    expect(status(dir)).toBe("");

    // And an ordinary commit after that has nothing to restamp at all.
    writeAndStage(dir, "today, again\n");
    commit(dir, "Second commit of the day");
    expect(headFiles(dir)).not.toContain("README.md");
    expect(headFile(dir, "README.md")).toContain("**Current version:** 0.1.2");
    expect(status(dir)).toBe("");
  });
});
