import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Folders nobody opens in a code pane, and whose listing would cost seconds. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "obj", "bin", ".next", ".turbo", "coverage"]);
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 2_000_000;

export type EditorEntry = { name: string; path: string; dir: boolean };

export type EditorDiagnostic = {
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  message: string;
  severity: "error" | "warning" | "info";
  rule: string | null;
};

/** Absolute path inside the project root, or null when the request climbs out of it. */
export function insideRoot(root: string, rel: string): string | null {
  const base = path.resolve(root);
  // A backslash is a separator on Windows only; read it as one everywhere, so a
  // Windows-style `..\..\x` that reaches a POSIX server is refused instead of
  // resolving to a file whose name happens to carry backslashes.
  const abs = path.resolve(base, (rel || ".").replace(/\\/g, "/"));
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

function requireInside(root: string, rel: string): string {
  const abs = insideRoot(root, rel);
  if (!abs) throw new Error("path escapes root");
  return abs;
}

export async function listEntries(root: string, rel: string): Promise<EditorEntry[]> {
  const dirents = await fsp.readdir(requireInside(root, rel), { withFileTypes: true });
  return dirents
    .filter((d) => !(d.isDirectory() && SKIP_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, path: rel ? `${rel}/${d.name}` : d.name, dir: d.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES);
}

export async function readText(root: string, rel: string): Promise<{ path: string; text: string }> {
  const abs = requireInside(root, rel);
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error("not a file");
  if (stat.size > MAX_FILE_BYTES) throw new Error("file too large");
  return { path: rel, text: await fsp.readFile(abs, "utf8") };
}

export async function writeText(root: string, rel: string, text: string): Promise<void> {
  await fsp.writeFile(requireInside(root, rel), text, "utf8");
}

function runCapture(cmd: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // No shell: the bin is a plain node script, and a shell would re-split a
    // project path that happens to contain a space.
    const child = spawn(cmd, args, { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    // oxlint exits non-zero when it reports anything, and oxfmt when it cannot
    // parse the buffer: the output is the answer, only a missing process throws.
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !out.trim()) reject(new Error(err.trim() || `exit ${code}`));
      else resolve(out);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export type ToolSource = "project" | "bundled";
/** How the pane picks a tool: the project's copy, ours, or the project's if it has one. */
export type ToolPreference = "auto" | "project" | "bundled";
/** `missing` = the project does not use this tool at all, so the pane stays off. */
export type ToolStatus = { version: string; source: ToolSource | "missing" };

type Tool = { bin: string; version: string; source: ToolSource };

/**
 * Config files that mean "this project runs that tool". `.editorconfig` is not
 * here: it styles every project and says nothing about a formatter.
 */
const LINT_SIGNS = [".oxlintrc.json", ".oxlintrc.jsonc"];
const FORMAT_SIGNS = [
  ".oxfmtrc.json",
  ".oxfmtrc.jsonc",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

/** The file's own folder up to the pane root, nearest first. */
function walkUp(rootAbs: string, abs: string): string[] {
  const dirs: string[] = [];
  let dir = path.dirname(abs);
  for (;;) {
    dirs.push(dir);
    if (dir === rootAbs || !dir.startsWith(rootAbs)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** `package.json` of one folder, read once per lookup — they are small. */
function packageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** The project's own copy installed in `<dir>/node_modules`. */
function installedAt(dir: string, pkg: string): Tool | null {
  const json = packageJson(path.join(dir, "node_modules", pkg));
  if (!json) return null;
  const bin = json.bin as string | Record<string, string> | undefined;
  const entry = typeof bin === "string" ? bin : (bin?.[pkg] ?? `bin/${pkg}`);
  return {
    bin: path.join(dir, "node_modules", pkg, entry),
    version: String(json.version ?? "—"),
    source: "project",
  };
}

function bundled(pkg: string): Tool | null {
  try {
    const dir = path.dirname(require.resolve(`${pkg}/package.json`));
    const json = packageJson(dir);
    if (!json) return null;
    const bin = json.bin as string | Record<string, string> | undefined;
    const entry = typeof bin === "string" ? bin : (bin?.[pkg] ?? `bin/${pkg}`);
    return { bin: path.join(dir, entry), version: String(json.version ?? "—"), source: "bundled" };
  } catch {
    return null;
  }
}

/**
 * Nearest folder between the file and the pane root that has `pkg` installed.
 *
 * shortcut: the nearest copy wins, exactly as Node resolves it — even when the
 * workspace root holds another version the project's build uses. Upgrade when a
 * project needs one compiler/linxer version everywhere: then the workspace root
 * (`pnpm-workspace.yaml` / `workspaces`) decides and the package only fills
 * gaps.
 */
function installedTool(rootAbs: string, abs: string, pkg: string): Tool | null {
  for (const dir of walkUp(rootAbs, abs)) {
    const tool = installedAt(dir, pkg);
    if (tool) return tool;
  }
  return null;
}

/**
 * Does the project itself run this tool? A config file next to the code, or the
 * tool named in the nearest `package.json` (a dependency or a script). Without
 * that the tool is not the project's business: oxlint would lint a project that
 * never chose it, which is exactly what a pane must not do.
 */
function projectRuns(rootAbs: string, abs: string, pkg: "oxlint" | "oxfmt"): boolean {
  const signs = pkg === "oxlint" ? LINT_SIGNS : FORMAT_SIGNS;
  for (const dir of walkUp(rootAbs, abs)) {
    if (signs.some((name) => existsSync(path.join(dir, name)))) return true;
    const json = packageJson(dir);
    if (!json) continue;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const deps = json[field];
      if (deps && typeof deps === "object" && pkg in (deps as Record<string, unknown>)) return true;
    }
    const scripts = json.scripts;
    const scriptText =
      scripts && typeof scripts === "object" ? Object.values(scripts as Record<string, string>).join(" ") : "";
    if (scriptText.includes(pkg)) return true;
    // oxfmt formats what a prettier setup already describes.
    if (pkg === "oxfmt" && ("prettier" in json || /prettier/.test(scriptText))) return true;
  }
  return false;
}

/**
 * Where the tools of one file live. `auto` takes the project's copy and falls
 * back to ours, but only for a tool the project actually runs; `project` and
 * `bundled` are an explicit choice and never guess.
 */
function resolveTool(
  pkg: "oxlint" | "oxfmt",
  rootAbs: string,
  abs: string,
  prefer: ToolPreference,
): Tool | null {
  if (prefer === "bundled") return bundled(pkg);
  const project = installedTool(rootAbs, abs, pkg);
  if (project) return project;
  if (prefer === "project" || !projectRuns(rootAbs, abs, pkg)) return null;
  return bundled(pkg);
}

function toolOffReason(pkg: "oxlint" | "oxfmt", prefer: ToolPreference): string {
  return prefer === "project"
    ? `${pkg}: выбран источник «из проекта», но в проекте его нет`
    : `${pkg}: проект его не использует — нет ни конфига, ни записи в package.json`;
}

/**
 * The project a file belongs to: nearest folder with a `tsconfig.json`, else the
 * nearest one with a `package.json`, else the pane root. This is what the
 * language server is started in, so `web/tsconfig.json` is seen from a pane
 * opened on the repository above it.
 */
export function projectDir(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = requireInside(root, rel);
  let withPackage = rootAbs;
  for (const dir of walkUp(rootAbs, abs)) {
    if (existsSync(path.join(dir, "tsconfig.json"))) return dir;
    if (withPackage === rootAbs && existsSync(path.join(dir, "package.json"))) withPackage = dir;
  }
  return withPackage;
}

/**
 * The formatter reads the buffer from stdin and prints it back, so nothing is
 * written until the pane decides to save — a format is one undoable change.
 */
/** `text: null` with a `note` = the project does not format this file at all. */
export async function formatText(
  root: string,
  rel: string,
  text: string,
  prefer: ToolPreference = "auto",
): Promise<{ text: string | null; note?: string }> {
  const rootAbs = path.resolve(root);
  const abs = requireInside(root, rel);
  const tool = resolveTool("oxfmt", rootAbs, abs, prefer);
  if (!tool) return { text: null, note: toolOffReason("oxfmt", prefer) };
  // cwd is the project the file belongs to, so oxfmt picks up its `.oxfmtrc.json`
  // (or prettier config) the way it would from a terminal there.
  const formatted = await runCapture(
    process.execPath,
    [tool.bin, "--stdin-filepath", abs],
    projectDir(root, rel),
    text,
  );
  return { text: formatted };
}

/**
 * What the pane would run for this file and where it came from. TypeScript is
 * the language of the file, so for it the bundled copy is a normal answer;
 * oxlint and oxfmt belong to the project and are reported as `missing` (off)
 * when the project does not use them.
 */
export function toolStatus(
  root: string,
  rel: string,
  prefs: Record<"typescript" | "oxlint" | "oxfmt", ToolPreference> = {
    typescript: "auto",
    oxlint: "auto",
    oxfmt: "auto",
  },
): { tools: Record<"typescript" | "oxlint" | "oxfmt", ToolStatus>; project: string } {
  const rootAbs = path.resolve(root);
  const abs = requireInside(root, rel);
  const of = (pkg: "typescript" | "oxlint" | "oxfmt"): ToolStatus => {
    if (pkg === "typescript") {
      const tool =
        prefs.typescript === "bundled"
          ? bundled(pkg)
          : (installedTool(rootAbs, abs, pkg) ?? (prefs.typescript === "project" ? null : bundled(pkg)));
      return tool ? { version: tool.version, source: tool.source } : { version: "—", source: "missing" };
    }
    const tool = resolveTool(pkg, rootAbs, abs, prefs[pkg]);
    return tool ? { version: tool.version, source: tool.source } : { version: "—", source: "missing" };
  };
  return {
    tools: { typescript: of("typescript"), oxlint: of("oxlint"), oxfmt: of("oxfmt") },
    project: path.relative(rootAbs, projectDir(root, rel)).replaceAll(path.sep, "/"),
  };
}

/** oxlint reports on one file; the CLI is fast enough that a save can afford it. */
/**
 * `note` without diagnostics = the project does not run oxlint here, which is a
 * normal state and not a failure: a pane must not lint a project that never
 * asked for it.
 */
/** Extensions a relative import may leave out, in the order Node/TS try them. */
const MODULE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/**
 * The file a relative import points at, without asking the language server.
 * Aliases (`@/x`) and package names are left to the server: guessing them here
 * would mean re-implementing resolution.
 */
export async function resolveImport(
  root: string,
  fromRel: string,
  spec: string,
): Promise<string | null> {
  if (!spec.startsWith(".")) return null;
  const fromAbs = insideRoot(root, fromRel);
  if (!fromAbs) return null;
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [
    base,
    ...MODULE_EXTS.map((ext) => base + ext),
    ...MODULE_EXTS.map((ext) => path.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    const rel = insideRoot(root, path.relative(path.resolve(root), candidate));
    if (!rel) continue;
    try {
      if ((await fsp.stat(candidate)).isFile()) return path.relative(path.resolve(root), candidate).replaceAll("\\", "/");
    } catch {
      // Next candidate.
    }
  }
  return null;
}

type TsModule = typeof import("typescript");
type ProjectConfig = { ts: TsModule; options: import("typescript").CompilerOptions } | null;

/** Compiler options per folder, so one tsconfig is parsed once per pane. */
const configs = new Map<string, ProjectConfig>();

/** The compiler that owns a project: its own copy first, ours as a fallback. */
function compilerFor(dir: string): TsModule | null {
  for (const anchor of [path.join(dir, "package.json"), import.meta.url]) {
    try {
      return createRequire(anchor)("typescript") as TsModule;
    } catch {
      // Next anchor: a project may have no TypeScript of its own.
    }
  }
  return null;
}

/** The nearest tsconfig above a file, parsed the way `tsc` would parse it. */
function configFor(root: string, fromAbs: string): ProjectConfig {
  const base = path.resolve(root);
  const walked: string[] = [];
  let result: ProjectConfig = null;
  for (let dir = path.dirname(fromAbs); ; dir = path.dirname(dir)) {
    if (configs.has(dir)) {
      result = configs.get(dir) ?? null;
      break;
    }
    walked.push(dir);
    if (existsSync(path.join(dir, "tsconfig.json"))) {
      const ts = compilerFor(dir);
      const parsed = ts?.getParsedCommandLineOfConfigFile(path.join(dir, "tsconfig.json"), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {},
      });
      result = ts && parsed ? { ts, options: parsed.options } : null;
      break;
    }
    if (dir === base || path.dirname(dir) === dir) break;
  }
  for (const dir of walked) configs.set(dir, result);
  return result;
}

/**
 * The file a module specifier points at: any kind the project's own compiler
 * understands — relative, `baseUrl`, tsconfig `paths`, package, `#` subpath
 * import — because it is the compiler doing the resolving, not a guess.
 */
export async function resolveSpecifier(
  root: string,
  fromRel: string,
  spec: string,
): Promise<string | null> {
  const fromAbs = insideRoot(root, fromRel);
  if (!fromAbs) return null;
  const config = configFor(root, fromAbs);
  if (!config) return resolveImport(root, fromRel, spec);
  const resolved = config.ts.resolveModuleName(spec, fromAbs, config.options, config.ts.sys).resolvedModule;
  const file = resolved?.resolvedFileName;
  if (!file) return null;
  const abs = insideRoot(root, path.relative(path.resolve(root), file));
  // A package's own sources are the server's business, not the pane's.
  if (!abs || abs.split(/[\\/]/).includes("node_modules")) return null;
  return path.relative(path.resolve(root), abs).replaceAll("\\", "/");
}

/** Where a top-level declaration of `name` starts in a file, if it has one. */
function declarationIn(ts: TsModule, text: string, name: string): { line: number; col: number } | null {
  const source = ts.createSourceFile("pane.ts", text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    const named = statement as unknown as { name?: { text?: string } };
    if (named.name?.text !== name) continue;
    const at = source.getLineAndCharacterOfPosition(statement.getStart(source));
    return { line: at.line + 1, col: at.character + 1 };
  }
  return null;
}

/**
 * Where a name imported through `spec` is actually declared, without asking the
 * language server: the compiler resolves the specifier, the compiler reads the
 * syntax tree, and a barrel's re-export line leads to the next hop.
 */
export async function findDeclaration(
  root: string,
  fromRel: string,
  spec: string,
  name: string,
): Promise<{ path: string; line: number; col: number } | null> {
  let from = fromRel;
  let specifier = spec;
  for (let hop = 0; hop < 4 && specifier; hop += 1) {
    const target = await resolveSpecifier(root, from, specifier);
    const abs = target ? insideRoot(root, target) : null;
    const ts = abs ? (configFor(root, abs)?.ts ?? compilerFor(root)) : null;
    const text = ts && abs ? await fsp.readFile(abs, "utf8").catch(() => null) : null;
    if (!target || !ts || !text) return null;
    const found = declarationIn(ts, text, name);
    if (found) return { path: target, line: found.line, col: found.col };
    // A barrel re-exports the name instead of declaring it: follow that line.
    const line = text
      .split("\n")
      .find((one) => /^\s*export\b/.test(one) && one.includes(name) && /from\s*["']/.test(one));
    specifier = line ? (/from\s*["']([^"']+)["']/.exec(line)?.[1] ?? "") : "";
    from = target;
  }
  return null;
}

/**
 * The relative imports of a file and of their imports, breadth first. tsserver
 * only knows the documents it was handed, so the pane feeds it this reachable
 * set — enough for a jump through a barrel, far cheaper than a whole tsconfig.
 */
export async function resolveImports(
  root: string,
  rel: string,
  depth = 3,
  max = 400,
): Promise<string[]> {
  const seen = new Set<string>([rel]);
  let frontier = [rel];
  for (let level = 0; level < depth && frontier.length && seen.size < max; level += 1) {
    const found = await Promise.all(
      frontier.map(async (file) => {
        const abs = insideRoot(root, file);
        if (!abs) return [];
        const text = await fsp.readFile(abs, "utf8").catch(() => "");
        // `from "x"`, `import "x"` and `export … from "x"`; aliases and packages
        // are left to the server, which resolves them in its own program.
        const specs = new Set(
          [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]),
        );
        const paths = await Promise.all([...specs].map((spec) => resolveSpecifier(root, file, spec)));
        return paths.filter((p): p is string => Boolean(p));
      }),
    );
    frontier = [];
    for (const file of found.flat()) {
      if (seen.has(file) || seen.size >= max) continue;
      seen.add(file);
      frontier.push(file);
    }
  }
  seen.delete(rel);
  return [...seen];
}

/** What oxlint actually parses — anything else it would report as "no files found". */
const LINT_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue"]);

export async function lintFile(
  root: string,
  rel: string,
  prefer: ToolPreference = "auto",
): Promise<{ diagnostics: EditorDiagnostic[]; note?: string }> {
  if (!LINT_EXTS.has(path.extname(rel).slice(1).toLowerCase())) return { diagnostics: [] };
  const rootAbs = path.resolve(root);
  const abs = requireInside(root, rel);
  const tool = resolveTool("oxlint", rootAbs, abs, prefer);
  if (!tool) return { diagnostics: [], note: toolOffReason("oxlint", prefer) };
  // cwd is the file's own project: oxlint reads its `.oxlintrc.json` from there.
  const out = await runCapture(
    process.execPath,
    [tool.bin, "--format=json", abs],
    projectDir(root, rel),
  );
  return { diagnostics: parseOxlint(out, abs) };
}

type OxlintLabel = { span?: { line?: number; column?: number; length?: number } };
type OxlintItem = {
  message?: string;
  help?: string;
  code?: string;
  severity?: string;
  filename?: string;
  labels?: OxlintLabel[];
};

export function parseOxlint(raw: string, abs: string): EditorDiagnostic[] {
  // oxlint wraps findings in an object next to its statistics (and prints them
  // after other chatter), so cut from the first brace, not from the first bracket.
  const start = raw.indexOf("{");
  if (start < 0) return [];
  let items: OxlintItem[];
  try {
    items = (JSON.parse(raw.slice(start)) as { diagnostics?: OxlintItem[] }).diagnostics ?? [];
  } catch {
    return [];
  }
  return items
    .filter((item) => item.message)
    .map((item) => {
      const span = item.labels?.[0]?.span;
      const line = Math.max(1, span?.line ?? 1);
      const col = Math.max(1, span?.column ?? 1);
      return {
        file: abs,
        line,
        col,
        endLine: line,
        endCol: col + Math.max(1, span?.length ?? 1),
        message: item.help ? `${item.message} — ${item.help}` : (item.message ?? ""),
        severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
        rule: item.code ?? null,
      };
    });
}
