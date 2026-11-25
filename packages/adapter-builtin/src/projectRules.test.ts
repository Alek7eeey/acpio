import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectRules,
  parseRuleFile,
  renderProjectRules,
  renderRuleNotes,
  touchedFiles,
} from "./projectRules.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acpio-rules-"));
  created.push(dir);
  return dir;
}

function file(dir: string, rel: string, text: string): void {
  const full = join(dir, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

describe("parseRuleFile", () => {
  it("treats a file with no frontmatter as always applied", () => {
    const rule = parseRuleFile("# House style\n\nTabs, not spaces.\n", "AGENTS.md");
    expect(rule).toMatchObject({ path: "AGENTS.md", always: true, body: "# House style\n\nTabs, not spaces." });
  });

  it("reads alwaysApply, globs and description off the frontmatter", () => {
    const rule = parseRuleFile(
      "---\ndescription: UI conventions\nglobs: src/ui/**/*.tsx\nalwaysApply: true\n---\nUse the design tokens.",
      ".cursor/rules/ui.mdc",
    );
    expect(rule).toEqual({
      path: ".cursor/rules/ui.mdc",
      description: "UI conventions",
      globs: "src/ui/**/*.tsx",
      always: true,
      body: "Use the design tokens.",
    });
  });

  it("keeps a glob-gated rule out of the always set", () => {
    const rule = parseRuleFile("---\nglobs: **/*.py\nalwaysApply: false\n---\nPEP 8.", ".cursor/rules/py.mdc");
    expect(rule.always).toBe(false);
    expect(rule.globs).toBe("**/*.py");
  });

  it("joins a YAML block list of globs", () => {
    const rule = parseRuleFile(
      "---\ndescription: tests\nglobs:\n  - src/**/*.test.ts\n  - e2e/**\n---\nCover the failure first.",
      ".cursor/rules/tests.mdc",
    );
    expect(rule.globs).toBe("src/**/*.test.ts, e2e/**");
    expect(rule.always).toBe(false);
  });

  it("honours an explicit alwaysApply: false", () => {
    const rule = parseRuleFile("---\nalwaysApply: false\n---\nBe brief.", "r.mdc");
    expect(rule.always).toBe(false);
  });
});

describe("touchedFiles", () => {
  const call = (toolName: string, input: Record<string, unknown>): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "c1", toolName, input }],
  });

  it("collects the files read, edited or written, once each", () => {
    expect(
      touchedFiles(
        [
          call("read", { path: "web/src/a.ts" }),
          call("edit", { path: "web\\src\\a.ts" }),
          call("write", { path: "docs/new.md" }),
          // Not a file of the project: a shell command, or a tool without a path.
          call("bash", { command: "ls" }),
          call("read", { path: "/tmp/elsewhere.md" }),
        ],
        "/work",
      ),
    ).toEqual(["web/src/a.ts", "docs/new.md"]);
  });

  it("makes an absolute path inside the folder relative", () => {
    expect(touchedFiles([call("read", { path: join("/work", "src", "a.ts") })], "/work")).toEqual(
      ["src/a.ts"],
    );
  });
});

describe("renderRuleNotes", () => {
  it("hands over a globs rule once the conversation touched a matching file", async () => {
    const cwd = tempDir();
    file(cwd, ".cursor/rules/ui.mdc", "---\nglobs: src/ui/**\n---\nUse tokens.");
    const none = await renderRuleNotes(cwd, undefined, [], new Set());
    expect(none).toEqual({ text: "", paths: [] });

    const touched = await renderRuleNotes(cwd, undefined, ["src/ui/Button.tsx"], new Set());
    expect(touched.text).toContain("--- .cursor/rules/ui.mdc ---\nUse tokens.");
    expect(touched.paths).toEqual([".cursor/rules/ui.mdc"]);
    // The rule stays a path in the block the head carries.
    expect(await renderProjectRules(cwd)).toContain("- `.cursor/rules/ui.mdc` (globs: src/ui/**)");

    // A file of another area leaves the rule where it was.
    expect((await renderRuleNotes(cwd, undefined, ["server/main.py"], new Set())).text).toBe("");
    // A rule that already arrived is not sent again.
    expect(
      (await renderRuleNotes(cwd, undefined, ["src/ui/Button.tsx"], new Set([".cursor/rules/ui.mdc"])))
        .text,
    ).toBe("");
  });

  it("matches any of a comma-separated globs list", async () => {
    const cwd = tempDir();
    file(cwd, ".cursor/rules/ts.mdc", "---\nglobs: web/**/*.ts, web/**/*.tsx\n---\nNo `as`.");
    expect((await renderRuleNotes(cwd, undefined, ["web/plugins/a.tsx"], new Set())).text).toContain(
      "No `as`.",
    );
    expect((await renderRuleNotes(cwd, undefined, ["web/plugins/a.css"], new Set())).text).toBe("");
  });

  it("leaves an always-on rule out of the note: the head already carries it", async () => {
    const cwd = tempDir();
    file(cwd, "AGENTS.md", "Tabs, not spaces.");
    expect((await renderRuleNotes(cwd, undefined, ["AGENTS.md"], new Set())).text).toBe("");
  });
});

describe("renderProjectRules", () => {
  it("is empty when the repository ships no rules", async () => {
    expect(await renderProjectRules(tempDir())).toBe("");
  });

  it("inlines always-on rules and lists the conditional ones", async () => {
    const cwd = tempDir();
    file(cwd, "AGENTS.md", "Tabs, not spaces.");
    file(cwd, ".cursorrules", "Never commit secrets.");
    file(cwd, ".cursor/rules/base.mdc", "---\nalwaysApply: true\n---\nRun npm test before replying.");
    file(cwd, ".cursor/rules/nested/ui.mdc", "---\ndescription: UI conventions\nglobs: src/ui/**\n---\nUse tokens.");
    const prompt = await renderProjectRules(cwd);
    expect(prompt).toContain("--- AGENTS.md ---\nTabs, not spaces.");
    expect(prompt).toContain("--- .cursorrules ---\nNever commit secrets.");
    expect(prompt).toContain("--- .cursor/rules/base.mdc ---\nRun npm test before replying.");
    // A rule about some files only is named, not inlined.
    expect(prompt).toContain("- `.cursor/rules/nested/ui.mdc` — UI conventions (globs: src/ui/**)");
    expect(prompt).not.toContain("Use tokens.");
    expect(prompt).toContain("more specific than the rules above");
  });

  it("keeps a globs rule a path even when a matching file is on the wire", async () => {
    // The head is written once per chat: a rule that starts to match arrives as
    // a tail note (`renderRuleNotes`), never by rewriting these bytes.
    const cwd = tempDir();
    file(cwd, ".cursor/rules/ui.mdc", "---\nglobs: src/ui/**\n---\nUse tokens.");
    const prompt = await renderProjectRules(cwd);
    expect(prompt).toContain("- `.cursor/rules/ui.mdc` (globs: src/ui/**)");
    expect(prompt).not.toContain("Use tokens.");
  });

  it("caps one huge rule's text and lists the next that no longer fits", async () => {
    const cwd = tempDir();
    file(cwd, "AGENTS.md", "x".repeat(9_000));
    file(cwd, ".cursorrules", "y".repeat(9_000));
    const prompt = await renderProjectRules(cwd);
    expect(prompt).toContain("--- AGENTS.md ---");
    expect(prompt).toContain("...[truncated]...");
    expect(prompt).not.toContain("x".repeat(9_000));
    // The budget is spent: naming the second file still earns the read.
    expect(prompt).toContain("- `.cursorrules`");
  });

  it("follows the configured patterns, and an empty list turns them off", async () => {
    const cwd = tempDir();
    file(cwd, "AGENTS.md", "Tabs, not spaces.");
    file(cwd, "docs/rules/team.md", "Ship small.");
    const prompt = await renderProjectRules(cwd, ["docs/rules/*.md"]);
    expect(prompt).toContain("--- docs/rules/team.md ---\nShip small.");
    expect(prompt).not.toContain("Tabs, not spaces.");
    expect(await renderProjectRules(cwd, [])).toBe("");
  });

  it("discovers rules nested under .cursor/rules", async () => {
    const cwd = tempDir();
    file(cwd, ".cursor/rules/a/b/deep.mdc", "Deep.");
    expect((await discoverProjectRules(cwd)).map((rule) => rule.path)).toEqual([".cursor/rules/a/b/deep.mdc"]);
  });
});

describe("~ — the user's own rules for every project", () => {
  it("reads them from home and inlines the one that always applies", async () => {
    const home = tempDir();
    file(home, ".agents/rules/base.md", "Always answer in Russian.");
    const cwd = tempDir();
    file(cwd, "AGENTS.md", "Tabs, not spaces.");
    const prompt = await renderProjectRules(cwd, ["AGENTS.md", "~/.agents/rules/**/*.md"], home);
    expect(prompt).toContain("--- AGENTS.md ---\nTabs, not spaces.");
    expect(prompt).toContain("--- ~/.agents/rules/base.md ---\nAlways answer in Russian.");
    expect(prompt).toContain("the user's own rules, meant for every project");
    // The same rule is the user's wherever the chat's folder is.
    const other = tempDir();
    expect(await renderProjectRules(other, ["~/.agents/rules/**/*.md"], home)).toContain(
      "Always answer in Russian.",
    );
  });

  it("never lists a globs-gated one — no tool can open a path outside the chat — but hands it over on a match", async () => {
    const home = tempDir();
    file(home, ".agents/rules/ts.md", "---\nglobs: **/*.ts\n---\nNo `as`.");
    const cwd = tempDir();
    const patterns = ["~/.agents/rules/**/*.md"];
    // Nothing to read, so the head stays empty instead of naming an unreadable path.
    expect(await renderProjectRules(cwd, patterns, home)).toBe("");
    const note = await renderRuleNotes(cwd, patterns, ["src/a.ts"], new Set(), home);
    expect(note.text).toContain("--- ~/.agents/rules/ts.md ---\nNo `as`.");
    expect(note.paths).toEqual(["~/.agents/rules/ts.md"]);
    expect((await renderRuleNotes(cwd, patterns, ["src/a.ts"], new Set(note.paths), home)).text).toBe("");
  });

  it("carries a home rule that gates on nothing whole: no globs to trigger it, no path to open", async () => {
    const home = tempDir();
    file(home, ".agents/rules/mine.md", "---\ndescription: my habits\nalwaysApply: false\n---\nBe brief.");
    const cwd = tempDir();
    expect(await renderProjectRules(cwd, ["~/.agents/rules/**/*.md"], home)).toContain(
      "--- ~/.agents/rules/mine.md ---\nBe brief.",
    );
    expect((await renderRuleNotes(cwd, ["~/.agents/rules/**/*.md"], ["a.ts"], new Set(), home)).text).toBe(
      "",
    );
  });

  it("inlines what still fits when the budget runs out instead of listing it", async () => {
    const home = tempDir();
    file(home, "AGENTS.md", "x".repeat(9_000));
    file(home, ".agents/rules/big.md", "y".repeat(9_000));
    const prompt = await renderProjectRules(tempDir(), ["~/AGENTS.md", "~/.agents/rules/big.md"], home);
    expect(prompt).toContain("--- ~/AGENTS.md ---");
    expect(prompt).toContain("--- ~/.agents/rules/big.md ---");
    expect(prompt).not.toContain("y".repeat(9_000));
  });
});
