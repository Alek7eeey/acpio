import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteGitFiles, discardGitChanges, getGitStatus, unquoteGitPath } from "./git.js";

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
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
  });

  function repo() {
    const dir = tempRepo();
    repos.push(dir);
    return dir;
  }

  const changedPaths = (dir: string) =>
    getGitStatus(dir)
      .files.map((file) => file.path)
      .sort();

  it("deletes an untracked folder with all of its files", () => {
    const dir = repo();
    write(dir, "piper/en_US-ryan.onnx", "a\n");
    write(dir, "piper/espeak-ng-data/en_dict", "b\n");
    write(dir, "piper/espeak-ng-data/ru_dict", "c\n");

    expect(deleteGitFiles(dir, ["piper/"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "piper"))).toBe(false);
    expect(changedPaths(dir)).toEqual([]);
  });

  it("discards an untracked folder with all of its files", () => {
    const dir = repo();
    write(dir, "piper/en_US-ryan.onnx", "a\n");
    write(dir, "piper/espeak-ng-data/en_dict", "b\n");

    expect(discardGitChanges(dir, ["piper"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "piper"))).toBe(false);
    expect(changedPaths(dir)).toEqual([]);
  });

  it("restores tracked files and drops untracked ones in one folder", () => {
    const dir = repo();
    write(dir, "mod/tracked.txt", "base\n");
    git(dir, ["add", "mod/tracked.txt"]);
    git(dir, ["commit", "-m", "add"]);
    write(dir, "mod/tracked.txt", "changed\n");
    write(dir, "mod/nested/new.txt", "new\n");

    expect(discardGitChanges(dir, ["mod"])).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, "mod/tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(dir, "mod/nested"))).toBe(false);
    expect(changedPaths(dir)).toEqual([]);
  });

  it("discards a staged new file inside a folder", () => {
    const dir = repo();
    write(dir, "d/a.txt", "a\n");
    write(dir, "d/b.txt", "b\n");
    git(dir, ["add", "d/a.txt"]);

    expect(discardGitChanges(dir, ["d"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "d"))).toBe(false);
    expect(changedPaths(dir)).toEqual([]);
  });

  it("deletes a folder holding tracked and untracked files", () => {
    const dir = repo();
    write(dir, "mixed/tracked.txt", "base\n");
    git(dir, ["add", "mixed/tracked.txt"]);
    git(dir, ["commit", "-m", "add"]);
    write(dir, "mixed/untracked.txt", "new\n");

    expect(deleteGitFiles(dir, ["mixed"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "mixed"))).toBe(false);
    // The tracked deletion stays staged for commit; the untracked file is gone.
    expect(getGitStatus(dir).files.map((file) => [file.path, file.index, file.worktree])).toEqual([
      ["mixed/tracked.txt", "D", " "],
    ]);
  });

  it("handles paths git reports quoted", () => {
    const dir = repo();
    write(dir, "ru/мой файл.txt", "base\n");
    expect(changedPaths(dir)).toEqual(["ru/мой файл.txt"]);

    expect(deleteGitFiles(dir, ["ru/мой файл.txt"])).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, "ru/мой файл.txt"))).toBe(false);
    expect(changedPaths(dir)).toEqual([]);
  });
});
