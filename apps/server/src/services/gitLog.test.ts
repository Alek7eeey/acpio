import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitLog } from "./git.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Commit clock: paging is only deterministic when no two commits share a date. */
let clock = Date.UTC(2026, 0, 1, 12, 0, 0);

function git(cwd: string, args: string[]) {
  clock += 60_000;
  const stamp = new Date(clock).toISOString();
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function commitFile(repo: string, name: string, message: string) {
  fs.writeFileSync(path.join(repo, name), `${message}\n`);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

/**
 * main: c1 → c2 → c3, feature/x branches off c2 with f1, and origin/feature/x
 * points at f1 so the filter list has a remote entry too.
 */
function repoWithBranches() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-log-"));
  dirs.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  commitFile(repo, "a.txt", "c1");
  const c2 = commitFile(repo, "b.txt", "c2");
  git(repo, ["checkout", "-b", "feature/x"]);
  const f1 = commitFile(repo, "f.txt", "f1");
  git(repo, ["update-ref", "refs/remotes/origin/feature/x", f1]);
  git(repo, ["checkout", "main"]);
  commitFile(repo, "c.txt", "c3");
  return { repo, c2, f1 };
}

describe("getGitLog", () => {
  it("lists commits of every branch by default", async () => {
    const { repo } = repoWithBranches();
    const page = await getGitLog(repo, { limit: 50 });
    const subjects = page.commits.map((commit) => commit.subject);

    expect(subjects).toContain("f1"); // reachable only from feature/x
    expect(subjects).toEqual(expect.arrayContaining(["c1", "c2", "c3", "f1"]));
    expect(page.branches).toEqual(["feature/x", "main", "origin/feature/x"]);
    expect(page.hasMore).toBe(false);
  });

  it("pages through history without repeating or dropping a commit", async () => {
    const { repo } = repoWithBranches();
    const first = await getGitLog(repo, { limit: 2 });
    expect(first.commits).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const seen = first.commits.map((commit) => commit.hash);
    let hasMore = first.hasMore;
    let skip = seen.length;
    while (hasMore) {
      const next = await getGitLog(repo, { limit: 2, skip });
      seen.push(...next.commits.map((commit) => commit.hash));
      skip += next.commits.length;
      hasMore = next.hasMore;
    }

    expect(new Set(seen).size).toBe(seen.length);
    const all = await getGitLog(repo, { limit: 50 });
    expect(seen.sort()).toEqual(all.commits.map((commit) => commit.hash).sort());
  });

  it("keeps the outgoing list to the first page", async () => {
    const { repo } = repoWithBranches();
    expect((await getGitLog(repo, { limit: 2, skip: 0 })).outgoing).toEqual([]);
    expect((await getGitLog(repo, { limit: 2, skip: 2 })).outgoing).toEqual([]);
  });

  it("filters history by the branches it is given", async () => {
    const { repo } = repoWithBranches();
    const feature = await getGitLog(repo, { limit: 50, branches: ["feature/x"] });
    expect(feature.commits.map((commit) => commit.subject)).toEqual(["f1", "c2", "c1"]);

    const main = await getGitLog(repo, { limit: 50, branches: ["main"] });
    expect(main.commits.map((commit) => commit.subject)).toEqual(["c3", "c2", "c1"]);

    const both = await getGitLog(repo, { limit: 50, branches: ["main", "origin/feature/x"] });
    expect(both.commits.map((commit) => commit.subject)).toEqual(
      expect.arrayContaining(["c3", "f1", "c2", "c1"]),
    );
  });

  it("answers an unknown branch with no commits but keeps the filter list", async () => {
    const { repo } = repoWithBranches();
    const page = await getGitLog(repo, { limit: 50, branches: ["no-such-branch"] });
    expect(page.commits).toEqual([]);
    expect(page.hasMore).toBe(false);
    // The panel still needs the branches, or the filter that got here is a dead end.
    expect(page.branches).toEqual(["feature/x", "main", "origin/feature/x"]);
  });

  it("ignores a filter entry that is not a valid revision", async () => {
    const { repo } = repoWithBranches();
    const page = await getGitLog(repo, { limit: 50, branches: ["--all"] });
    // Nothing usable is left, so the log falls back to every branch.
    expect(page.commits.map((commit) => commit.subject)).toContain("c3");
  });

  it("marks the refs a commit carries", async () => {
    const { repo } = repoWithBranches();
    const page = await getGitLog(repo, { limit: 50 });
    const tip = page.commits.find((commit) => commit.subject === "f1");
    expect(tip?.refs).toContain("feature/x");
  });
});
