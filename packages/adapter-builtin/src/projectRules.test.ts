import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverProjectRules,
  parseRuleFile,
  renderProjectRules,
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

describe("renderProjectRules", () => {
  it("inlines a globs rule once the conversation touched a matching file", async () => {
    const cwd = tempDir();
    file(cwd, ".cursor/rules/ui.mdc", "---\nglobs: src/ui/**\n---\nUse tokens.");
    const untouched = await renderProjectRules(cwd);
    expect(untouched).toContain("- `.cursor/rules/ui.mdc` (globs: src/ui/**)");
    expect(untouched).not.toContain("Use tokens.");

    const touched = await renderProjectRules(cwd, undefined, ["src/ui/Button.tsx"]);
    expect(touched).toContain("--- .cursor/rules/ui.mdc ---\nUse tokens.");
    expect(touched).not.toContain("Conditional project rules");

    // A file of another area leaves the rule where it was.
    const other = await renderProjectRules(cwd, undefined, ["server/main.py"]);
    expect(other).not.toContain("Use tokens.");
  });

  it("matches any of a comma-separated globs list", async () => {
    const cwd = tempDir();
    file(cwd, ".cursor/rules/ts.mdc", "---\nglobs: web/**/*.ts, web/**/*.tsx\n---\nNo `as`.");
    expect(await renderProjectRules(cwd, undefined, ["web/plugins/a.tsx"])).toContain("No `as`.");
    expect(await renderProjectRules(cwd, undefined, ["web/plugins/a.css"])).not.toContain("No `as`.");
  });

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
