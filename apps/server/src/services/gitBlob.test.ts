import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitFileBytes } from "./git.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository with one commit behind it, so HEAD and the disk can differ. */
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpio-git-blob-"));
  dirs.push(dir);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    return result.stdout;
  };
  git(["init", "-q"]);
  return dir;
}

function commit(repoDir: string) {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: process.env });
  git("add", "-A");
  git("commit", "-q", "-m", "one");
}

/** Bytes no text reader survives: NULs and high values are the point. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

describe("getGitFileBytes", () => {
  it("reads a revision and the working copy byte for byte", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "shot.png"), PNG);
    commit(dir);
    // Saved again since: the two sides of a change are different bytes.
    fs.writeFileSync(path.join(dir, "shot.png"), Buffer.concat([PNG, Buffer.from([0x01])]));

    const revision = await getGitFileBytes(dir, "shot.png", "HEAD");
    const working = await getGitFileBytes(dir, "shot.png");

    expect(revision?.equals(PNG)).toBe(true);
    expect(working?.equals(Buffer.concat([PNG, Buffer.from([0x01])]))).toBe(true);
  });

  it("answers null for a side that does not exist", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "shot.png"), PNG);
    commit(dir);
    fs.rmSync(path.join(dir, "shot.png"));

    // A new file has no copy in the revision; a deleted one none on disk.
    expect(await getGitFileBytes(dir, "shot.png", "HEAD")).not.toBeNull();
    expect(await getGitFileBytes(dir, "shot.png")).toBeNull();
    expect(await getGitFileBytes(dir, "added.png", "HEAD")).toBeNull();
  });

  it("refuses a path that climbs out of the repository", async () => {
    const dir = repo();
    const outside = path.join(dir, "..", `outside-${path.basename(dir)}.png`);
    fs.writeFileSync(outside, PNG);
    try {
      expect(await getGitFileBytes(dir, `../${path.basename(outside)}`)).toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
