import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addGitIgnoreEntries, appendGitIgnoreEntries, toGitIgnorePattern } from "./git.js";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

describe("toGitIgnorePattern", () => {
  it.each<[string, boolean, string]>([
    ["notes.txt", false, "/notes.txt"],
    ["web/src/app.ts", false, "/web/src/app.ts"],
    ["build", true, "/build/"],
    ["web\\dev-dist", true, "/web/dev-dist/"],
    ["./tmp/", true, "/tmp/"],
    ["", false, ""],
  ])("%j (dir=%s) → %j", (relPath, isDir, expected) => {
    expect(toGitIgnorePattern(relPath, isDir)).toBe(expected);
  });

  it("escapes a trailing space so git keeps it in the name", async () => {
    expect(toGitIgnorePattern("my file ", false)).toBe("/my file\\ ");
  });
});

describe("appendGitIgnoreEntries", () => {
  it("appends new patterns on their own lines", async () => {
    expect(appendGitIgnoreEntries("node_modules\n", ["/build/", "/notes.txt"])).toEqual({
      content: "node_modules\n/build/\n/notes.txt\n",
      added: ["/build/", "/notes.txt"],
    });
  });

  it("keeps existing CRLF line endings", async () => {
    const result = appendGitIgnoreEntries("node_modules\r\n", ["/build/"]);
    expect(result.content).toBe("node_modules\r\n/build/\r\n");
  });

  it("terminates a file that has no trailing newline", async () => {
    expect(appendGitIgnoreEntries("node_modules", ["/build/"]).content).toBe("node_modules\n/build/\n");
  });

  it("skips patterns already present, including duplicates in the same call", async () => {
    const result = appendGitIgnoreEntries("# comment\n/build/\n", ["/build/", "/x y", "/x y"]);
    expect(result).toEqual({ content: "# comment\n/build/\n/x y\n", added: ["/x y"] });
  });

  it("leaves the file untouched when every pattern is already ignored", async () => {
    expect(appendGitIgnoreEntries("/build/\n", ["/build/"])).toEqual({
      content: "/build/\n",
      added: [],
    });
  });
});

describe("addGitIgnoreEntries", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempRepo() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-ignore-"));
    dirs.push(repo);
    git(repo, ["init"]);
    return repo;
  }

  it("adds a file and a directory to the root .gitignore", async () => {
    const repo = tempRepo();
    fs.mkdirSync(path.join(repo, "dev-dist"));
    fs.writeFileSync(path.join(repo, "dev-dist", "sw.js"), "");
    fs.writeFileSync(path.join(repo, "notes.txt"), "");
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");

    const result = await addGitIgnoreEntries(repo, ["notes.txt", "dev-dist"]);

    expect(result).toEqual({ ok: true, added: ["/notes.txt", "/dev-dist/"] });
    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe(
      "node_modules\n/notes.txt\n/dev-dist/\n",
    );
    // Both entries are gone from the report, which is the point of the action.
    const status = git(repo, ["status", "--porcelain=v1", "-uall"]);
    expect(status).not.toContain("notes.txt");
    expect(status).not.toContain("dev-dist");
    expect(status).toContain(".gitignore");
  });

  it("creates .gitignore when the repository has none", async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, "notes.txt"), "");

    expect(await addGitIgnoreEntries(repo, ["notes.txt"])).toEqual({ ok: true, added: ["/notes.txt"] });
    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("/notes.txt\n");
  });

  it("reports nothing added when the path is already ignored", async () => {
    const repo = tempRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "/notes.txt\n");
    expect(await addGitIgnoreEntries(repo, ["notes.txt"])).toEqual({ ok: true, added: [] });
  });

  it("rejects a path that escapes the repository", async () => {
    const repo = tempRepo();
    const result = await addGitIgnoreEntries(repo, ["../outside.txt"]);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
  });

  it("fails outside a repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-ignore-plain-"));
    dirs.push(dir);
    const result = await addGitIgnoreEntries(dir, ["notes.txt"]);
    expect(result).toMatchObject({ ok: false });
  });
});
