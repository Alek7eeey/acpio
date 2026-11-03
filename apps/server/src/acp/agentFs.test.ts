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

/** The workspace above plus a `.cursorignore` with what a real project writes. */
async function ignoreWorkspace(): Promise<string> {
  const root = await workspace();
  await fsp.mkdir(path.join(root, "bin", "Debug"), { recursive: true });
  await fsp.writeFile(path.join(root, "bin", "Debug", "app.txt"), "hidden calcTotal\n");
  await fsp.mkdir(path.join(root, "web", "packages", "ui"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "web", "packages", "ui", "calc.ts"),
    "export const calcTotal = 3;\n",
  );
  await fsp.writeFile(
    path.join(root, ".cursorignore"),
    "# build output\n**/[Bb]in/\n**/packages/\n!web/packages/\n!web/packages/**\n",
  );
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("globFiles", () => {
  it("matches a recursive pattern, skips node_modules and sizes each file", async () => {
    const root = await workspace();
    expect(await globFiles({ root, pattern: "**/*.ts" })).toEqual({
      files: [
        { path: "src/a.ts", bytes: Buffer.byteLength("export const calcTotal = 1;\n") },
        { path: "src/nested/b.ts", bytes: Buffer.byteLength("// call calctotal here\n") },
      ],
      truncated: false,
    });
  });

  it("matches a bare filename pattern at any depth", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "*.md" })).files.map((f) => f.path)).toEqual([
      "README.md",
    ]);
  });

  it("keeps the depth of a non-recursive pattern", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "src/*.ts" })).files.map((f) => f.path)).toEqual([
      "src/a.ts",
    ]);
  });

  it("reports truncation instead of scanning past the limit", async () => {
    const root = await workspace();
    expect(await globFiles({ root, pattern: "**/*.ts", maxResults: 1 })).toEqual({
      files: [{ path: "src/a.ts", bytes: Buffer.byteLength("export const calcTotal = 1;\n") }],
      truncated: true,
    });
  });

  it("returns nothing for an empty pattern", async () => {
    const root = await workspace();
    expect((await globFiles({ root, pattern: "   " })).files).toEqual([]);
  });

  it("counts the lines of a file that matched, the way hits number them", async () => {
    const root = await workspace();
    const { hits, files } = await searchFiles({ root, pattern: "calcTotal" });
    const a = files.find((f) => f.path === "src/a.ts");
    expect(a).toEqual({
      path: "src/a.ts",
      bytes: Buffer.byteLength("export const calcTotal = 1;\n"),
      // The empty tail after the final newline counts, as it does in hit numbering.
      lines: 2,
    });
    expect(hits.find((h) => h.path === "src/a.ts")?.line).toBe(1);
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

  it("scopes a search to one directory, and reports paths the folder's way", async () => {
    const root = await workspace();
    const { hits } = await searchFiles({
      root,
      dir: path.join(root, "src", "nested"),
      pattern: "calctotal",
      ignoreCase: true,
    });
    // Folder-relative, like every other answer: the path goes back into `read`.
    expect(hits.map((h) => h.path)).toEqual(["src/nested/b.ts"]);
  });

  it("stops at maxResults and says so", async () => {
    const root = await workspace();
    const { hits, truncated } = await searchFiles({ root, pattern: "calc", maxResults: 1 });
    expect(hits).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("keeps what .cursorignore hides out of the walk, and a negated folder in", async () => {
    const root = await ignoreWorkspace();
    expect((await globFiles({ root, pattern: "**/*.ts" })).files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/nested/b.ts",
      "web/packages/ui/calc.ts",
    ]);
    const { hits } = await searchFiles({ root, pattern: "calcTotal" });
    expect(hits.map((h) => h.path)).toEqual([
      "README.md",
      "src/a.ts",
      "web/packages/ui/calc.ts",
    ]);
  });

  it("says which folders the ignore files kept out of the walk", async () => {
    const root = await ignoreWorkspace();
    const res = await searchFiles({ root, pattern: "nothing-matches-this" });
    expect(res.ignoredDirCount).toBe(1);
    expect(res.ignoredDirs).toEqual(["bin"]);
  });

  it("searches a folder the model names, ignored or not", async () => {
    const root = await ignoreWorkspace();
    const quiet = await searchFiles({ root, pattern: "calcTotal" });
    expect(quiet.hits.map((h) => h.path)).not.toContain("bin/Debug/app.txt");

    // Saying the folder is the answer to "nothing was found there": the walk
    // starts inside it and applies no ignore of its own for this call.
    const named = await searchFiles({
      root,
      dir: path.join(root, "bin"),
      pattern: "hidden",
    });
    expect(named.hits.map((h) => h.path)).toEqual(["bin/Debug/app.txt"]);
  });

  it("still searches a file the model names, ignored or not", async () => {
    const root = await ignoreWorkspace();
    const { hits } = await searchFiles({
      root,
      dir: path.join(root, "bin", "Debug", "app.txt"),
      pattern: "hidden",
    });
    expect(hits.map((h) => h.path)).toEqual(["bin/Debug/app.txt"]);
  });

  it("explains a bad regular expression instead of throwing raw", async () => {
    const root = await workspace();
    await expect(searchFiles({ root, pattern: "(unclosed" })).rejects.toThrow(
      /Некорректное регулярное выражение/,
    );
  });
});
