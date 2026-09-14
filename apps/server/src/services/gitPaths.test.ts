import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteGitFiles, discardGitChanges, getGitDiff, getGitStatus, unquoteGitPath } from "./git.js";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function tempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-gitpaths-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  // Keep restored worktree bytes identical to what the test wrote.
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function write(repo: string, rel: string, content: string) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Temp repos opened by a test, deleted when that test ends. */
const repos: string[] = [];

afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

function repo() {
  const dir = tempRepo();
  repos.push(dir);
  return dir;
}

describe("unquoteGitPath", () => {
  it.each([
    ["plain/path.ts", "plain/path.ts"],
    ['"with space.txt"', "with space.txt"],
    ['"quote\\"inside.txt"', 'quote"inside.txt'],
    ['"tab\\there.txt"', "tab\there.txt"],
    ['"\\320\\277\\321\\200.txt"', "пр.txt"],
    ['"mixed \\320\\260 b.txt"', "mixed а b.txt"],
    ['"trailing\\ space "', "trailing space "],
    ['"unterminated', '"unterminated'],
  ])("%j → %j", (raw, expected) => {
    expect(unquoteGitPath(raw)).toBe(expected);
  });
});

describe("folder-level git file operations", () => {
  const changedPaths = async (dir: string) =>
    (await getGitStatus(dir)).files.map((file) => file.path).sort();

  it("deletes an untracked folder with all of its files", async () => {
    const dir = repo();
    write(dir, "piper/en_US-ryan.onnx", "a\n");
    write(dir, "piper/espeak-ng-data/en_dict", "b\n");
    write(dir, "piper/espeak-ng-data/ru_dict", "c\n");

    expect(await deleteGitFiles(dir, ["piper/"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "piper"))).toBe(false);
    expect(await changedPaths(dir)).toEqual([]);
  });

  it("discards an untracked folder with all of its files", async () => {
    const dir = repo();
    write(dir, "piper/en_US-ryan.onnx", "a\n");
    write(dir, "piper/espeak-ng-data/en_dict", "b\n");

    expect(await discardGitChanges(dir, ["piper"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "piper"))).toBe(false);
    expect(await changedPaths(dir)).toEqual([]);
  });

  it("restores tracked files and drops untracked ones in one folder", async () => {
    const dir = repo();
    write(dir, "mod/tracked.txt", "base\n");
    git(dir, ["add", "mod/tracked.txt"]);
    git(dir, ["commit", "-m", "add"]);
    write(dir, "mod/tracked.txt", "changed\n");
    write(dir, "mod/nested/new.txt", "new\n");

    expect(await discardGitChanges(dir, ["mod"])).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, "mod/tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(dir, "mod/nested"))).toBe(false);
    expect(await changedPaths(dir)).toEqual([]);
  });

  it("discards a staged new file inside a folder", async () => {
    const dir = repo();
    write(dir, "d/a.txt", "a\n");
    write(dir, "d/b.txt", "b\n");
    git(dir, ["add", "d/a.txt"]);

    expect(await discardGitChanges(dir, ["d"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "d"))).toBe(false);
    expect(await changedPaths(dir)).toEqual([]);
  });

  it("deletes a folder holding tracked and untracked files", async () => {
    const dir = repo();
    write(dir, "mixed/tracked.txt", "base\n");
    git(dir, ["add", "mixed/tracked.txt"]);
    git(dir, ["commit", "-m", "add"]);
    write(dir, "mixed/untracked.txt", "new\n");

    expect(await deleteGitFiles(dir, ["mixed"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "mixed"))).toBe(false);
    // The tracked deletion stays staged for commit; the untracked file is gone.
    expect((await getGitStatus(dir)).files.map((file) => [file.path, file.index, file.worktree])).toEqual([
      ["mixed/tracked.txt", "D", " "],
    ]);
  });

  it("handles paths git reports quoted", async () => {
    const dir = repo();
    write(dir, "ru/мой файл.txt", "base\n");
    expect(await changedPaths(dir)).toEqual(["ru/мой файл.txt"]);

    expect(await deleteGitFiles(dir, ["ru/мой файл.txt"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "ru/мой файл.txt"))).toBe(false);
    expect(await changedPaths(dir)).toEqual([]);
  });
});

describe("per-file diffs", () => {
  it("diffs a tracked file against HEAD", async () => {
    const dir = repo();
    write(dir, "tracked.txt", "base\nchanged\n");
    expect(await getGitDiff(dir, "tracked.txt")).toContain("+changed");
  });

  it("shows nothing for a tracked file without changes", async () => {
    expect(await getGitDiff(repo(), "tracked.txt")).toBe("");
  });

  it("shows an untracked file's content as additions", async () => {
    const dir = repo();
    write(dir, "new.txt", "hello\n");
    expect(await getGitDiff(dir, "new.txt")).toContain("+hello");
  });

  it("shows nothing for a path that is not in the worktree", async () => {
    expect(await getGitDiff(repo(), "missing.txt")).toBe("");
  });
});

describe("changed-line totals", () => {
  it("counts staged and unstaged changes together", async () => {
    const dir = repo();
    write(dir, "staged.txt", "one\ntwo\n");
    git(dir, ["add", "staged.txt"]);
    write(dir, "tracked.txt", "base\nplus\n");

    // Both shapes feed the same header: the panel takes the full one, the
    // composer bar the summary.
    const full = await getGitStatus(dir);
    const summary = await getGitStatus(dir, { summary: true });
    expect(full.additions).toBe(3);
    expect(summary.additions).toBe(3);
    expect(full.deletions).toBe(0);
    expect(summary.deletions).toBe(0);
  });

  it("counts a line staged and then edited again once", async () => {
    const dir = repo();
    write(dir, "tracked.txt", "base\nstaged\n");
    git(dir, ["add", "tracked.txt"]);
    write(dir, "tracked.txt", "base\nedited\n");

    // Worktree vs HEAD adds one line and deletes none; summing the index and
    // worktree numstats instead would report 2 additions and 1 deletion.
    const full = await getGitStatus(dir);
    const summary = await getGitStatus(dir, { summary: true });
    expect([full.additions, full.deletions]).toEqual([1, 0]);
    // The composer chip reads the summary shape; a total counted twice here
    // would disagree with the panel header for the same worktree.
    expect([summary.additions, summary.deletions]).toEqual([1, 0]);
  });

  it("counts a repository that has no commits yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-gitpaths-fresh-"));
    repos.push(dir);
    git(dir, ["init"]);
    write(dir, "first.txt", "a\nb\n");
    git(dir, ["add", "first.txt"]);

    expect((await getGitStatus(dir, { summary: true })).additions).toBe(2);
    expect((await getGitStatus(dir)).additions).toBe(2);
  });
});
