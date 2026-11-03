import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIgnore, loadIgnoreFiles } from "./ignoreFiles.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-ignore-"));
  roots.push(root);
  return root;
}

describe("createIgnore", () => {
  it("ignores a bare folder name at any depth, and everything under it", () => {
    const rules = createIgnore("bin/\ndist\n");
    expect(rules.ignores("bin", true)).toBe(true);
    expect(rules.ignores("src/bin", true)).toBe(true);
    // gitignore: an ignored folder takes the files inside it along.
    expect(rules.ignores("src/bin/x.dll", false)).toBe(true);
    expect(rules.ignores("src/app.ts", false)).toBe(false);
  });

  it("keeps a folder a later negation brings back", () => {
    const rules = createIgnore("**/packages/\n!web/packages/\n");
    expect(rules.ignores("web/packages", true)).toBe(false);
    expect(rules.ignores("web/packages/ui/x.ts", false)).toBe(false);
    expect(rules.ignores("sdk/packages", true)).toBe(true);
  });

  it("lets a later file decide over an earlier one", () => {
    const rules = createIgnore("dist/\nlogs/\n", "!dist/\n");
    expect(rules.ignores("dist", true)).toBe(false);
    expect(rules.ignores("logs", true)).toBe(true);
  });

  it("honours char classes and globs, as real ignore files write them", () => {
    const rules = createIgnore("**/[Bb]in/\n**/*.log\nwebapi/swagger/**\n");
    expect(rules.ignores("Build/Bin/x.exe", false)).toBe(true);
    expect(rules.ignores("logs/app.log", false)).toBe(true);
    expect(rules.ignores("webapi/swagger/api.json", false)).toBe(true);
    expect(rules.ignores("src/app.ts", false)).toBe(false);
  });

  it("anchors a pattern that carries a folder of its own", () => {
    const rules = createIgnore("docs/tmp/\n");
    expect(rules.ignores("docs/tmp", true)).toBe(true);
    expect(rules.ignores("src/docs/tmp", true)).toBe(false);
  });

  it("skips comments and blank lines, and never ignores the root", () => {
    const rules = createIgnore("# a comment\n\n   \n");
    expect(rules.ignores("", false)).toBe(false);
    expect(rules.ignores("src/a.ts", false)).toBe(false);
  });
});

describe("loadIgnoreFiles", () => {
  it("reads every listed file, in the order the setting gives", async () => {
    const root = await tempDir();
    await fsp.writeFile(path.join(root, ".gitignore"), "dist/\n");
    await fsp.writeFile(path.join(root, ".cursorignore"), "!dist/\nbuild/\n");
    const rules = await loadIgnoreFiles(root, [".gitignore", ".cursorignore"]);
    expect(rules?.ignores("dist", true)).toBe(false);
    expect(rules?.ignores("build", true)).toBe(true);
  });

  it("is null when the folder ships none of the listed files", async () => {
    expect(await loadIgnoreFiles(await tempDir(), [".gitignore", ".cursorignore"])).toBeNull();
  });

  it("takes the default list for an absent setting and nothing for an empty one", async () => {
    const root = await tempDir();
    await fsp.writeFile(path.join(root, ".gitignore"), "dist/\n");
    expect((await loadIgnoreFiles(root, undefined))?.ignores("dist", true)).toBe(true);
    expect(await loadIgnoreFiles(root, [])).toBeNull();
  });
});
