import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSkills,
  expandSkillInvocation,
  matchSkillInvocation,
  parseSkillMarkdown,
} from "./skills.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acpio-skills-"));
  created.push(dir);
  return dir;
}

/** A `<dir>/<name>/SKILL.md` folder; returns the SKILL.md path. */
function skill(dir: string, name: string, md: string): string {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), md);
  return join(folder, "SKILL.md");
}

describe("parseSkillMarkdown", () => {
  it("reads name and description off the frontmatter", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: commit\ndescription: Выполнить git-коммит\n---\n\nDo the thing.\n",
      "folder",
    );
    expect(parsed).toEqual({
      name: "commit",
      description: "Выполнить git-коммит",
      body: "Do the thing.",
    });
  });

  it("falls back to the folder name and keeps the whole text without frontmatter", () => {
    const parsed = parseSkillMarkdown("Just steps.", "folder");
    expect(parsed.name).toBe("folder");
    expect(parsed.description).toBe("");
    expect(parsed.body).toBe("Just steps.");
  });
});

describe("discoverSkills", () => {
  it("finds skill folders under a path relative to the cwd", async () => {
    const cwd = tempDir();
    const commit = skill(
      join(cwd, ".agents", "skills"),
      "commit",
      "---\nname: commit\ndescription: Make a commit\n---\nbody",
    );
    const notes = skill(join(cwd, ".agents", "skills"), "notes", "no frontmatter");
    expect(await discoverSkills([".agents/skills"], cwd)).toEqual([
      { name: "commit", description: "Make a commit", path: commit },
      { name: "notes", description: "", path: notes },
    ]);
  });

  it("scans absolute paths and ignores missing ones", async () => {
    const global = tempDir();
    const deploy = skill(global, "deploy", "---\ndescription: Ship it\n---\nbody");
    expect(await discoverSkills([global, join(global, "missing")], tempDir())).toEqual([
      { name: "deploy", description: "Ship it", path: deploy },
    ]);
  });

  it("expands ~ against the given home folder", async () => {
    const home = tempDir();
    const global = skill(
      join(home, ".agents", "skills"),
      "commit",
      "---\nname: commit\ndescription: From the home collection\n---\nbody",
    );
    expect(await discoverSkills(["~/.agents/skills"], tempDir(), home)).toEqual([
      { name: "commit", description: "From the home collection", path: global },
    ]);
  });

  it("prefers the first folder on a name clash and caps junk entries", async () => {
    const first = tempDir();
    const second = tempDir();
    const a = skill(first, "same", "---\nname: same\n---\nfirst");
    skill(second, "same", "---\nname: same\n---\nsecond");
    expect(await discoverSkills([first, second], tempDir())).toEqual([
      { name: "same", description: "", path: a },
    ]);
  });

  it("gives an empty list when skills are off or nothing exists", async () => {
    const cwd = tempDir();
    expect(await discoverSkills([], cwd)).toEqual([]);
    expect(await discoverSkills([".agents/skills"], cwd)).toEqual([]);
  });
});

describe("matchSkillInvocation", () => {
  const skills = [
    { name: "commit", description: "", path: "C:/x/commit/SKILL.md" },
    { name: "notes", description: "", path: "C:/x/notes/SKILL.md" },
  ];

  it("matches /name with and without args, case-insensitively", () => {
    expect(matchSkillInvocation("/commit", skills)).toEqual({ skill: skills[0], args: "" });
    expect(matchSkillInvocation("/Commit fix the bug", skills)).toEqual({
      skill: skills[0],
      args: "fix the bug",
    });
  });

  it("returns null for unknown names and plain text", () => {
    expect(matchSkillInvocation("/nope", skills)).toBeNull();
    expect(matchSkillInvocation("fix the bug", skills)).toBeNull();
    expect(matchSkillInvocation("/commit extra", [skills[1]])).toBeNull();
  });
});

describe("expandSkillInvocation", () => {
  it("inlines the skill body plus the request", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    const expanded = await expandSkillInvocation("/commit fix the lint", skills);
    expect(expanded).toContain('invoked the skill "commit"');
    expect(expanded).toContain("Run git commit.");
    expect(expanded).toContain("User request: fix the lint");
    expect(expanded).not.toContain("name: commit"); // frontmatter stays out
  });

  it("returns null for a message that is not a skill call", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    expect(await expandSkillInvocation("fix the lint", skills)).toBeNull();
    expect(await expandSkillInvocation("/nope", skills)).toBeNull();
  });
});
