import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globFiles, searchFiles } from "./agentFs.js";

const roots: string[] = [];

/** Small workspace with the shapes the walk has to get right. */
async function workspace(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "acpio-agentfs-"));
  roots.push(root);
  await fsp.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fsp.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
  await fsp.writeFile(path.join(root, "README.md"), "# Title\n\ncalcTotal helper\n");
  await fsp.writeFile(path.join(root, "src", "a.ts"), "export const calcTotal = 1;\n");
  await fsp.writeFile(path.join(root, "src", "nested", "b.ts"), "// call calctotal here\n");
  await fsp.writeFile(path.join(root, "node_modules", "dep", "index.ts"), "export const calcTotal = 2;\n");
  await fsp.writeFile(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x63, 0x61, 0x6c, 0x63]));
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("globFiles", () => {
  it("matches a recursive pattern and skips node_modules", async () => {
    const root = await workspace();
    expect(await globFiles({ root, pattern: "**/*.ts" })).toEqual({
      files: ["src/a.ts", "src/nested/b.ts"],
      truncated: false,
    });
  });

  it("matches a bare filename pattern at any depth", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "*.md" })).files).toEqual(["README.md"]);
  });

  it("keeps the depth of a non-recursive pattern", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "src/*.ts" })).files).toEqual(["src/a.ts"]);
  });

  it("reports truncation instead of scanning past the limit", async () => {
    const root = await workspace();
    expect(await globFiles({ root, pattern: "**/*.ts", maxResults: 1 })).toEqual({
      files: ["src/a.ts"],
      truncated: true,
    });
  });

  it("returns nothing for an empty pattern", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "   " })).files).toEqual([]);
  });
});

describe("searchFiles", () => {
  it("lists path, line and text for every match", async () => {
    const root = await workspace();
    const { hits } = await searchFiles({ root, pattern: "calcTotal" });
    expect(hits).toEqual([
      { path: "README.md", line: 3, text: "calcTotal helper" },
      { path: "src/a.ts", line: 1, text: "export const calcTotal = 1;" },
    ]);
  });

  it("honours ignore_case and a file glob", async () => {
    const root = await workspace();
    const { hits } = await searchFiles({
      root,
      pattern: "calctotal",
      ignoreCase: true,
      glob: "**/*.ts",
    });
    expect(hits.map((h) => h.path)).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("skips node_modules and binary files", async () => {
    const root = await workspace();
    const { hits, filesScanned } = await searchFiles({ root, pattern: "calc" });
    expect(hits.map((h) => h.path)).toEqual(["README.md", "src/a.ts", "src/nested/b.ts"]);
    expect(hits.some((h) => h.path.includes("node_modules"))).toBe(false);
    expect(hits.some((h) => h.path.endsWith(".bin"))).toBe(false);
    expect(filesScanned).toBeLessThan(6);
  });

  it("scopes a search to one directory", async () => {
    const root = await workspace();
    const { hits } = await searchFiles({
      root,
      dir: path.join(root, "src", "nested"),
      pattern: "calctotal",
      ignoreCase: true,
    });
    expect(hits.map((h) => h.path)).toEqual(["b.ts"]);
  });

  it("stops at maxResults and says so", async () => {
    const root = await workspace();
    const { hits, truncated } = await searchFiles({ root, pattern: "calc", maxResults: 1 });
    expect(hits).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("explains a bad regular expression instead of throwing raw", async () => {
    const root = await workspace();
    await expect(searchFiles({ root, pattern: "(unclosed" })).rejects.toThrow(
      /Некорректное регулярное выражение/,
    );
  });
});
