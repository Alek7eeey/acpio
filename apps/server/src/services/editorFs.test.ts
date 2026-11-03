import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatText,
  insideRoot,
  lintFile,
  parseOxlint,
  projectDir,
  resolveImport,
  resolveImports,
  toolStatus,
} from "./editorFs.js";

/** Verbatim shape of `oxlint --format=json` on oxlint 1.90. */
const OXLINT_JSON = `{ "diagnostics": [{"message": "\`debugger\` statement is not allowed","code": "eslint(no-debugger)","severity": "warning","url": "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-debugger.html","help": "Remove the debugger statement","filename": "tmp-probe.ts","labels": [{"span": {"offset": 30,"length": 9,"line": 2,"column": 3}}]}],
              "number_of_files": 1,
              "number_of_rules": 96,
              "threads_count": 24,
              "start_time": 0.007203
            }`;

/** A pane opened on a repository whose real project sits one folder down. */
const repo = mkdtempSync(path.join(os.tmpdir(), "acpio-editorfs-"));

function write(rel: string, text: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

// `web/` is a project that runs oxlint; `plain/` is a project that does not.
write("package.json", JSON.stringify({ name: "monorepo", private: true }));
write("web/package.json", JSON.stringify({ name: "web", devDependencies: { oxlint: "^1.90.0" } }));
write("web/tsconfig.json", "{}");
write("web/src/a.ts", "export const a = 1;\n");
write("plain/package.json", JSON.stringify({ name: "plain" }));
write("plain/b.ts", "export const b = 1;\n");

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("parseOxlint", () => {
  it("reads the diagnostics object oxlint actually prints", () => {
    const [item] = parseOxlint(OXLINT_JSON, "C:\\p\\tmp-probe.ts");
    expect(item).toMatchObject({
      line: 2,
      col: 3,
      endLine: 2,
      endCol: 12,
      severity: "warning",
      rule: "eslint(no-debugger)",
    });
    expect(item.message).toContain("Remove the debugger statement");
  });

  it("returns nothing when oxlint had no findings", () => {
    expect(parseOxlint(`{ "diagnostics": [], "number_of_files": 1 }`, "a.ts")).toEqual([]);
    expect(parseOxlint("nothing here", "a.ts")).toEqual([]);
  });
});

describe("projectDir", () => {
  it("names the folder the file's own project lives in", () => {
    expect(path.relative(repo, projectDir(repo, "web/src/a.ts"))).toBe(path.join("web"));
    expect(path.relative(repo, projectDir(repo, "plain/b.ts"))).toBe(path.join("plain"));
    // No tsconfig and no package.json anywhere: the pane root itself.
    expect(projectDir(repo, "")).toBe(path.resolve(repo));
  });
});

describe("toolStatus", () => {
  it("finds a tool in the project above the file, not only in the pane root", () => {
    // oxlint is installed in this repo's apps/server, the test file lives deeper.
    const status = toolStatus(process.cwd(), "apps/server/src/services/editorFs.ts");
    expect(status.tools.oxlint).toMatchObject({ source: "project" });
    expect(status.tools.typescript).toMatchObject({ source: "project" });
    expect(status.project).toBe("apps/server");
  });

  it("says a tool is off when the project never chose it", () => {
    expect(toolStatus(repo, "plain/b.ts").tools.oxlint.source).toBe("missing");
    expect(toolStatus(repo, "web/src/a.ts").tools.oxlint.source).toBe("bundled");
    // TypeScript is the language of the file: the bundled copy is a fine answer.
    expect(toolStatus(repo, "plain/b.ts").tools.typescript.source).toBe("bundled");
  });

  it("honours an explicit choice even where the project has nothing", () => {
    const bundled = toolStatus(repo, "plain/b.ts", {
      typescript: "auto",
      oxlint: "bundled",
      oxfmt: "bundled",
    });
    expect(bundled.tools.oxlint).toMatchObject({ source: "bundled" });
    expect(bundled.tools.oxfmt).toMatchObject({ source: "bundled" });
  });
});

describe("resolveImport", () => {
  it("finds the file behind a relative import, extension and index included", async () => {
    write("web/src/kit/index.ts", "export const kit = 1;\n");
    expect(await resolveImport(repo, "web/src/a.ts", "./kit")).toBe("web/src/kit/index.ts");
    expect(await resolveImport(repo, "web/src/a.ts", "./kit/index")).toBe("web/src/kit/index.ts");
    expect(await resolveImport(repo, "web/src/a.ts", "../tsconfig.json")).toBe("web/tsconfig.json");
  });

  it("leaves aliases, packages and escaping paths to the language server", async () => {
    expect(await resolveImport(repo, "web/src/a.ts", "@/lib/x")).toBeNull();
    expect(await resolveImport(repo, "web/src/a.ts", "react")).toBeNull();
    expect(await resolveImport(repo, "web/src/a.ts", "./missing")).toBeNull();
    expect(await resolveImport(repo, "web/src/a.ts", "../../../../etc/passwd")).toBeNull();
  });
});

describe("resolveImports", () => {
  it("lists the files a document imports, once each and relative only", async () => {
    write("web/src/kit/index.ts", "export const kit = 1;\n");
    write("web/src/util.ts", "export const util = 2;\n");
    write(
      "web/src/a.ts",
      [
        'import { util } from "./util";',
        'import "./kit";',
        'import { kit } from "./kit/index";',
        'import React from "react";',
        'import type { X } from "@/lib/x";',
        'export { util as u } from "./util";',
        "",
      ].join("\n"),
    );
    expect(await resolveImports(repo, "web/src/a.ts")).toEqual(["web/src/util.ts", "web/src/kit/index.ts"]);
  });

  it("walks through a barrel transitively, so a jump lands past `export * from`", async () => {
    write("web/deep/inner/leaf.ts", "export interface Leaf { a: 1 }\n");
    write("web/deep/inner/index.ts", "export * from './leaf';\n");
    write("web/deep/index.ts", "export * from './inner';\n");
    write("web/user.ts", 'import type { Leaf } from "./deep";\n');
    expect(await resolveImports(repo, "web/user.ts")).toEqual([
      "web/deep/index.ts",
      "web/deep/inner/index.ts",
      "web/deep/inner/leaf.ts",
    ]);
  });

  it("resolves every import kind the project's compiler does: paths and `#` subpaths", async () => {
    write(
      "app/tsconfig.json",
      JSON.stringify({
        compilerOptions: { module: "esnext", moduleResolution: "bundler", baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
    );
    write("app/package.json", JSON.stringify({ name: "app", imports: { "#kit": "./src/kit.ts" } }));
    write("app/src/kit.ts", "export const kit = 1;\n");
    write("app/src/lib.ts", "export const lib = 1;\n");
    write("app/src/user.ts", ['import { kit } from "#kit";', 'import { lib } from "@/lib";', ""].join("\n"));
    expect(await resolveImports(repo, "app/src/user.ts")).toEqual(["app/src/kit.ts", "app/src/lib.ts"]);
  });

  it("stops at the depth and at the file cap instead of walking a whole project", async () => {
    write("web/chain/0.ts", 'import "./1";\n');
    write("web/chain/1.ts", 'import "./2";\n');
    write("web/chain/2.ts", 'import "./3";\n');
    write("web/chain/3.ts", "export const end = 1;\n");
    expect(await resolveImports(repo, "web/chain/0.ts", 2)).toEqual(["web/chain/1.ts", "web/chain/2.ts"]);
    expect(await resolveImports(repo, "web/chain/0.ts", 3, 3)).toEqual(["web/chain/1.ts", "web/chain/2.ts"]);
  });

  it("says nothing about a file that does not exist", async () => {
    expect(await resolveImports(repo, "web/src/missing.ts")).toEqual([]);
  });
});

describe("lintFile", () => {
  it("does not lint a project that does not run oxlint", async () => {
    // oxlint exists in this repo, so a bundled copy is at hand — and must stay
    // unused, because `plain/` never asked for it.
    const res = await lintFile(repo, "plain/b.ts");
    expect(res.diagnostics).toEqual([]);
    expect(res.note).toMatch(/не использует/);
  });

  it("says nothing about a file the linter cannot parse", async () => {
    write("web/readme.yaml", "name: demo\none: push\n");
    const res = await lintFile(repo, "web/readme.yaml");
    expect(res.diagnostics).toEqual([]);
    expect(res.note).toBeUndefined();
  });

  it("lints where the project chose oxlint", async () => {
    write("web/src/c.ts", "export function f(x: number) {\n  debugger;\n  return x;\n}\n");
    const res = await lintFile(repo, "web/src/c.ts");
    expect(res.diagnostics.some((d) => d.rule === "eslint(no-debugger)")).toBe(true);
  });
});

describe("formatText", () => {
  it("runs the real oxfmt over the buffer of a project that formats", async () => {
    write("web/.oxfmtrc.json", JSON.stringify({ printWidth: 40, tabWidth: 4 }));
    write("web/src/d.ts", "export function f(a: number, b: number) { return a + b; }\n");
    const res = await formatText(repo, "web/src/d.ts", "export function f(a:number,b:number){return a+b}\n");
    // 4-space indent and width 40 come from `web/.oxfmtrc.json`, not from us.
    expect(res.text).toBe(
      "export function f(\n    a: number,\n    b: number,\n) {\n    return a + b;\n}\n",
    );
  });

  it("refuses to format where the project has no formatter", async () => {
    const res = await formatText(repo, "plain/b.ts", "const a=1\n");
    expect(res.text).toBeNull();
    expect(res.note).toMatch(/не использует/);
  });

  it("refuses a path outside the root", async () => {
    await expect(formatText(process.cwd(), "../escape.ts", "x")).rejects.toThrow(/escapes root/);
  });
});

describe("insideRoot", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";

  it("keeps reads inside the project and refuses a climb out of it", () => {
    expect(insideRoot(root, "src/a.ts")).not.toBeNull();
    expect(insideRoot(root, "")).toBe(root);
    expect(insideRoot(root, "..\\..\\Windows\\win.ini")).toBeNull();
  });
});
