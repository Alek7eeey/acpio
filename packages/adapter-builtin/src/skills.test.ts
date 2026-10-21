import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS_DIR,
  discoverAgentSkills,
  discoverSkills,
  enabledSkills,
  expandSkillInvocation,
  matchSkillInvocation,
  parseSkillMarkdown,
  renderSkillsSection,
  skillMode,
  supersededRules,
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
      disableModelInvocation: false,
      body: "Do the thing.",
    });
  });

  it("reads disable-model-invocation off the frontmatter", () => {
    const flagged = parseSkillMarkdown(
      "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\nBody.",
      "folder",
    );
    expect(flagged.disableModelInvocation).toBe(true);
    expect(flagged.description).toBe("Make a commit");
    expect(parseSkillMarkdown("---\nname: a\ndisable-model-invocation: yes\n---\nb", "f").disableModelInvocation).toBe(true);
    expect(parseSkillMarkdown("---\nname: a\ndisable-model-invocation: false\n---\nb", "f").disableModelInvocation).toBe(false);
    expect(parseSkillMarkdown("---\nname: a\n---\nb", "f").disableModelInvocation).toBe(false);
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
      { name: "commit", description: "Make a commit", disableModelInvocation: false, supersedes: [], path: commit },
      { name: "notes", description: "", disableModelInvocation: false, supersedes: [], path: notes },
    ]);
  });

  it("carries disable-model-invocation through discovery", async () => {
    const cwd = tempDir();
    const commit = skill(
      join(cwd, ".agents", "skills"),
      "commit",
      "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\nbody",
    );
    expect(await discoverSkills([".agents/skills"], cwd)).toEqual([
      { name: "commit", description: "Make a commit", disableModelInvocation: true, supersedes: [], path: commit },
    ]);
  });

  it("scans absolute paths and ignores missing ones", async () => {
    const global = tempDir();
    const deploy = skill(global, "deploy", "---\ndescription: Ship it\n---\nbody");
    expect(await discoverSkills([global, join(global, "missing")], tempDir())).toEqual([
      { name: "deploy", description: "Ship it", disableModelInvocation: false, supersedes: [], path: deploy },
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
      { name: "commit", description: "From the home collection", disableModelInvocation: false, supersedes: [], path: global },
    ]);
  });

  it("prefers the first folder on a name clash and caps junk entries", async () => {
    const first = tempDir();
    const second = tempDir();
    const a = skill(first, "same", "---\nname: same\n---\nfirst");
    skill(second, "same", "---\nname: same\n---\nsecond");
    expect(await discoverSkills([first, second], tempDir())).toEqual([
      { name: "same", description: "", disableModelInvocation: false, supersedes: [], path: a },
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
    { name: "commit", description: "", disableModelInvocation: false, supersedes: [], path: "C:/x/commit/SKILL.md" },
    { name: "notes", description: "", disableModelInvocation: false, supersedes: [], path: "C:/x/notes/SKILL.md" },
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

describe("skillMode", () => {
  it("defaults to listed and reads every configured mode case-insensitively", () => {
    expect(skillMode({ commit: "off" }, "commit")).toBe("off");
    expect(skillMode({ commit: "hidden" }, "commit")).toBe("hidden");
    expect(skillMode({ commit: "active" }, "commit")).toBe("active");
    expect(skillMode(undefined, "commit")).toBe("listed");
    expect(skillMode({}, "commit")).toBe("listed");
    expect(skillMode({ other: "active" }, "commit")).toBe("listed");
    expect(skillMode({ commit: "hidden" }, "Commit")).toBe("hidden");
  });
});

describe("discoverAgentSkills", () => {
  it("ships the built-in skills whatever the configured folders say", async () => {
    const found = await discoverAgentSkills([], tempDir());
    expect(found.some((s) => s.name === "verify-bugfix" && s.builtin === true)).toBe(true);
    expect(found.find((s) => s.name === "verify-bugfix")?.path.startsWith(BUILTIN_SKILLS_DIR)).toBe(
      true,
    );
  });

  it("keeps a folder's own skills and lets a shipped name win the clash", async () => {
    const cwd = tempDir();
    const own = skill(
      cwd,
      "verify-bugfix",
      "---\nname: verify-bugfix\ndescription: Shadowed\n---\nbody",
    );
    skill(cwd, "notes", "---\nname: notes\ndescription: Take notes\n---\nbody");
    const found = await discoverAgentSkills([cwd], cwd);
    expect(found.filter((s) => s.name === "verify-bugfix")[0]?.path).not.toBe(own);
    expect(found.some((s) => s.name === "notes" && s.builtin !== true)).toBe(true);
  });
});

describe("discoverAgentSkills, shipped folders", () => {
  it("lets a plugin's copy beat a same-named skill in the user's own folders", async () => {
    const cwd = tempDir();
    const plugin = tempDir();
    skill(plugin, "ponytail", "---\nname: ponytail\ndescription: Shipped\n---\nbody");
    skill(cwd, "ponytail", "---\nname: ponytail\ndescription: Shadowed\n---\nbody");
    const found = await discoverAgentSkills([cwd, plugin], cwd, undefined, [
      { path: plugin, supersedes: { ponytail: ["smallest-change"] } },
    ]);
    const ponies = found.filter((s) => s.name === "ponytail");
    expect(ponies).toHaveLength(1);
    expect(ponies[0].path.startsWith(plugin)).toBe(true);
    expect(ponies[0].builtin).toBe(true);
    // The declaration travels with the copy that won, not with the shadowed one.
    expect(ponies[0].supersedes).toEqual(["smallest-change"]);
  });
});

describe("supersededRules", () => {
  /** A folder that ships with the app, as plugin-api's `skillPath` declares it. */
  const shipped = (dir: string, supersedes: Record<string, string[]>) => ({
    path: dir,
    supersedes,
  });

  it("counts only a skill that is in effect from the first turn", async () => {
    const cwd = tempDir();
    skill(cwd, "lazy", "---\nname: lazy\n---\nbody");
    skill(cwd, "notes", "---\nname: notes\n---\nbody");
    const skills = await discoverSkills([cwd], cwd, undefined, [
      shipped(cwd, { lazy: ["smallest-change"] }),
    ]);
    expect(skills.find((s) => s.name === "lazy")?.supersedes).toEqual(["smallest-change"]);
    expect(skills.find((s) => s.name === "notes")?.supersedes).toEqual([]);
    expect([...supersededRules(skills, { lazy: "active" })]).toEqual(["smallest-change"]);
    // A listed skill is applied mid-chat, when the prompt is already fixed —
    // its claims about the base rules cannot reach it.
    expect(supersededRules(skills, { lazy: "listed" }).size).toBe(0);
    expect(supersededRules(skills).size).toBe(0);
  });

  it("ignores a hidden or disabled skill even when it names rules", async () => {
    const cwd = tempDir();
    skill(cwd, "lazy", "---\nname: lazy\ndisable-model-invocation: true\n---\nbody");
    const skills = await discoverSkills([cwd], cwd, undefined, [
      shipped(cwd, { lazy: ["verify"] }),
    ]);
    expect(supersededRules(skills, { lazy: "active" }).size).toBe(0);
  });

  it("leaves a user's own folder alone: a SKILL.md declares nothing", async () => {
    const cwd = tempDir();
    skill(cwd, "lazy", "---\nname: lazy\nsupersedes: smallest-change\n---\nbody");
    const skills = await discoverSkills([cwd], cwd);
    expect(skills[0]?.supersedes).toEqual([]);
  });
});

describe("enabledSkills", () => {
  it("keeps a hidden skill on the menu and drops only a disabled one", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nbody");
    skill(cwd, "notes", "---\nname: notes\n---\nbody");
    const skills = await discoverSkills([cwd], cwd);
    expect(enabledSkills(skills, { commit: "hidden" }).map((s) => s.name)).toEqual([
      "commit",
      "notes",
    ]);
    expect(enabledSkills(skills, { commit: "off" }).map((s) => s.name)).toEqual(["notes"]);
  });
});

describe("renderSkillsSection", () => {
  it("lists the skills the model may invoke and skips the flagged ones", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndescription: Make a commit\ndisable-model-invocation: true\n---\nbody");
    skill(cwd, "notes", "---\nname: notes\ndescription: Take notes\n---\nbody");
    const section = await renderSkillsSection(await discoverSkills([cwd], cwd));
    expect(section).toContain("- notes: Take notes");
    expect(section).not.toContain("commit");
  });

  it("renders nothing when every skill is flagged", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndisable-model-invocation: true\n---\nbody");
    expect(await renderSkillsSection(await discoverSkills([cwd], cwd))).toBe("");
  });

  it("drops a hidden skill from the listing but keeps a listed one", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndescription: Make a commit\n---\nbody");
    skill(cwd, "notes", "---\nname: notes\ndescription: Take notes\n---\nbody");
    const skills = await discoverSkills([cwd], cwd);
    const section = await renderSkillsSection(skills, { commit: "hidden" });
    expect(section).toContain("- notes: Take notes");
    expect(section).not.toContain("commit");
  });

  it("leaves no header behind when the only skill is hidden or disabled", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndescription: Make a commit\n---\nbody");
    const skills = await discoverSkills([cwd], cwd);
    const section = await renderSkillsSection(skills, { commit: "hidden" });
    expect(section).toBe("");
    expect(section).not.toContain("Skills available");
    expect(await renderSkillsSection(skills, { commit: "off" })).toBe("");
  });

  it("inlines the body of an active skill instead of leaving it to a read", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndescription: Make a commit\n---\nRun git commit; skip the report.");
    skill(cwd, "notes", "---\nname: notes\ndescription: Take notes\n---\nWrite it down.");
    const skills = await discoverSkills([cwd], cwd);
    const section = await renderSkillsSection(skills, { commit: "active" });
    expect(section).toContain("Skills active by default:");
    expect(section).toContain("Run git commit; skip the report.");
    expect(section).not.toContain("Write it down.");
    // Name alone: the body below already carries the description, and its path
    // would only invite a second read of the same file.
    expect(section).toContain("\n- commit — already in effect, its text is below.\n");
    expect(section).not.toContain("- commit:");
    expect(section.match(/commit\/SKILL\.md`/g) ?? []).toHaveLength(0);
    expect(section).toMatch(/\n- notes: Take notes — `.*notes.SKILL\.md`$/m);
  });
});

describe("expandSkillInvocation", () => {
  it("still inlines a flagged skill when the user asks for it by name", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\ndisable-model-invocation: true\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    const expanded = await expandSkillInvocation("/commit", skills);
    expect(expanded).toContain("Run git commit.");
  });

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

  it("still inlines a hidden skill — hiding is about the system prompt", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    expect(await expandSkillInvocation("/commit", skills, { commit: "hidden" })).toContain(
      "Run git commit.",
    );
  });

  it("refuses a disabled skill, so a typed /name stays ordinary text", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    expect(await expandSkillInvocation("/commit", skills, { commit: "off" })).toBeNull();
    expect(matchSkillInvocation("/commit", skills, { commit: "off" })).toBeNull();
    expect(enabledSkills(skills, { commit: "off" })).toEqual([]);
  });

  it("returns null for a message that is not a skill call", async () => {
    const cwd = tempDir();
    skill(cwd, "commit", "---\nname: commit\n---\nRun git commit.\n");
    const skills = await discoverSkills([cwd], cwd);
    expect(await expandSkillInvocation("fix the lint", skills)).toBeNull();
    expect(await expandSkillInvocation("/nope", skills)).toBeNull();
  });
});
