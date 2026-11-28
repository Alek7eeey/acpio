/**
 * Builds the publishable npm package `acpio` into dist-npm/:
 *
 *   dist-npm/package.json           generated manifest (bin, files, deps, bundle)
 *   dist-npm/bin/acpio.mjs          CLI — `npx acpio` / `npm i -g acpio`
 *   dist-npm/apps/server/dist/**    compiled server (it also serves the web UI), its
 *                                   entry folded into one file — see below
 *   dist-npm/apps/web/dist/**       compiled web UI
 *   dist-npm/node_modules/@acpio/*  compiled workspace packages, bundled into the tarball
 *   dist-npm/node_modules/typescript-language-server  the editor's LSP, carried as files
 *   dist-npm/scripts/…              node-pty patch, run by the package's postinstall
 *   dist-npm/README.md, LICENSE
 *
 * Layout mirrors the repo on purpose: the compiled server resolves its root with
 * fixed "../../.." hops (apps/server/dist/index.js → package root), so moving
 * the server deeper or shallower breaks the web UI path and the data dir. Every
 * module reads that root through `apps/server/src/root.ts`, one hop below
 * `apps/server`, which is also where the bundle below lands.
 *
 * The workspace packages are not on the registry, so they travel *inside* the
 * tarball: they are copied to dist-npm/node_modules/@acpio/<name> and listed in
 * bundledDependencies, which makes `npm pack` / `npm publish` embed them and the
 * consumer's install resolve `@acpio/*` without a registry lookup. Their
 * manifest is regenerated at the release version (a bundled copy that disagreed
 * with the pinned range would look "invalid" and make npm try to fetch it).
 *
 * Everything else the server imports is pure JS and is folded into the entry
 * point (see `bundleEntry`): the consumer's install used to fetch ~140 packages
 * — fastify, the AI SDK, drizzle, zod and their trees — to run 3 MB of
 * JavaScript. What stays a registry dependency is only what cannot be folded:
 * better-sqlite3 and node-pty carry a native binary for the consumer's platform
 * and Node ABI, and oxlint/oxfmt are native CLIs spawned out of their own
 * package folder. A clean `npm i -g` went from 136 packages / 22 s to 46 / 4 s,
 * and this build stays platform-independent.
 *
 * Usage: npm run pack:npm [-- --expect-tag v0.1.37 | --version-suffix -rc.1]
 *   --expect-tag <tag>      fail unless the tag (leading "v" ignored) equals the
 *                           version git derives — the guard a tag release runs.
 *   --version-suffix <sfx>  publish as <derived><sfx>, e.g. 0.1.39-rc.1: a
 *                           prerelease, which is not a release and so is not a
 *                           release tag — the way to put a build on the registry
 *                           without spending the next number (publish it under a
 *                           dist-tag other than `latest`).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { deriveVersion } from "./releaseTags.mjs";
import { stampPackedRelease } from "./versionHistory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(repoRoot, "dist-npm");
const PKG_NAME = "acpio";
const REPO_URL = "https://github.com/Alek7eeey/acpio";

/**
 * Packages the tarball keeps as real files instead of folding them in, because
 * nothing can fold them:
 *  - better-sqlite3 and node-pty carry a native `.node` binary built for the
 *    consumer's platform and Node ABI, so npm has to fetch them there;
 *  - oxlint and oxfmt are native CLIs spawned out of their own package folder
 *    (`editorFs` resolves `${pkg}/package.json`), and ship as a
 *    platform-specific optional dependency.
 * Everything else the server imports is pure JS and ends up in the bundle.
 */
const RUNTIME_EXTERNALS = ["better-sqlite3", "node-pty", "oxlint", "oxfmt"];

/**
 * Spawned, not imported: the editor pane runs `typescript-language-server`'s
 * CLI (`lspBridge` resolves the package to find it), so it must exist as files
 * on disk. It is pure JS with no dependencies of its own, which is why the
 * tarball carries it instead of making the consumer's install fetch it.
 */
const VENDORED_TOOLS = ["typescript-language-server"];

/** Workspace packages the compiled server imports at runtime (deps first). */
const WORKSPACE_PACKAGES = [
  "shared",
  "i18n",
  "adapter-cursor",
  "adapter-omp",
  "adapter-opencode",
  "adapter-builtin",
  "plugin-ponytail",
];

/** Everything a bundle must leave to the tarball's own node_modules. */
const BUNDLE_EXTERNALS = [
  ...WORKSPACE_PACKAGES.map((name) => `@acpio/${name}`),
  ...RUNTIME_EXTERNALS,
  ...VENDORED_TOOLS,
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Copy a directory tree, leaving out what must not travel (default: nothing extra). */
function copyDir(src, dest, skip = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Folders a package ships next to `dist/` and reads through `import.meta.url`
 * (`adapter-builtin`'s `BUILTIN_SKILLS_DIR`, a plugin's `skillPath`). Copying
 * only `dist/` shipped every install without a single built-in skill, and
 * nothing failed: the scan treats an absent folder as an empty one.
 */
function copyPackageAssets(name, dest) {
  const src = path.join(repoRoot, "packages", name);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "dist" || entry.name === "src") continue;
    copyDir(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

/** The number this revision is released as — the same one git stamps into the repo. */
function appVersion() {
  return deriveVersion(repoRoot, readJson(path.join(repoRoot, "package.json")).version);
}

/** Manifest of one bundled workspace package: dist only, pinned to the release version. */
function workspaceManifest(name, version) {
  const src = readJson(path.join(repoRoot, "packages", name, "package.json"));
  // The package's own entry, not a fixed one: a plugin exports its `server.js`.
  const main = src.main ?? "./dist/index.js";
  const types = src.types ?? "./dist/index.d.ts";
  return {
    name: src.name,
    version,
    type: "module",
    main,
    types,
    // No "development" condition: the bundle has no src/, so the built file is
    // the only entry point — exactly what a plain `node` run resolves.
    exports: {
      ".": { types, default: main },
    },
  };
}

/**
 * The registry packages the tarball leaves to the consumer's install.
 *
 * What used to be here — the server's and every bundled workspace package's
 * dependencies — is ~140 packages to download for 3 MB of JavaScript. Those
 * are folded into the bundle now, so only the un-foldable four remain.
 */
function runtimeDependencies() {
  const server = readJson(path.join(repoRoot, "apps", "server", "package.json")).dependencies ?? {};
  const out = {};
  for (const name of RUNTIME_EXTERNALS) {
    // A name the server no longer depends on would silently become an
    // unresolved import inside the bundle: nothing left to install, nothing to
    // fail at build time.
    if (!server[name]) {
      throw new Error(`apps/server does not depend on ${name} — drop it from RUNTIME_EXTERNALS`);
    }
    out[name] = server[name];
  }
  return out;
}

/**
 * Fold one compiled entry point into a single ESM file.
 *
 * `import.meta.url` of every module collapses into the file's own URL, so a
 * module that walks up from itself gets a different root — the server reads its
 * root through `src/root.ts` for exactly that reason, and a bundle that lands at
 * the same depth as the tree it replaces keeps that hop honest.
 */
async function bundleEntry({ from, to, externals }) {
  await esbuild.build({
    entryPoints: [from],
    outfile: to,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: externals,
    logLevel: "warning",
    // CJS dependencies still reach for `require` (esbuild's `__require` shim
    // resolves it at run time); an ESM file has no `require` unless the bundle
    // brings one. The import is aliased because esbuild declares
    // `createRequire` itself where a bundled module requires an external — the
    // same name twice is a SyntaxError at load, and the bundle never starts.
    banner: {
      js: 'import { createRequire as __acpioCreateRequire } from "node:module"; const require = __acpioCreateRequire(import.meta.url);',
    },
  });
}

/** Registry deps of one workspace package — what folding it in has to absorb. */
function packageRegistryDeps(name) {
  const deps = readJson(path.join(repoRoot, "packages", name, "package.json")).dependencies ?? {};
  return Object.keys(deps).filter((dep) => !dep.startsWith("@acpio/"));
}

const expectTagIndex = process.argv.indexOf("--expect-tag");
const expectTag = expectTagIndex === -1 ? null : (process.argv[expectTagIndex + 1] ?? "");
const suffixIndex = process.argv.indexOf("--version-suffix");
const versionSuffix = suffixIndex === -1 ? "" : (process.argv[suffixIndex + 1] ?? "");

if (expectTag !== null && versionSuffix) {
  console.error("Use either --expect-tag or --version-suffix, not both.");
  process.exit(1);
}
if (versionSuffix && !/^-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(versionSuffix)) {
  console.error(`--version-suffix ${versionSuffix} is not a semver prerelease suffix (expected e.g. -rc.1).`);
  process.exit(1);
}

const { version: derivedVersion, releases, releasedTag } = appVersion();
if (expectTag !== null && expectTag.replace(/^v/, "") !== derivedVersion) {
  console.error(
    `Tag ${expectTag} does not match the version these release tags derive (${derivedVersion}` +
      (releasedTag
        ? `, released as ${releasedTag})`
        : `, next after ${releases[0]?.tag ?? "no release"})`) +
      ".",
  );
  console.error(
    "The version is a function of the release tags — see VERSIONS.md for the numbers that exist.",
  );
  process.exit(1);
}
const version = `${derivedVersion}${versionSuffix}`;
console.log(
  `Packaging ${PKG_NAME}@${version} for npm` +
    (expectTag ? ` (tag ${expectTag})` : versionSuffix ? ` (prerelease of ${derivedVersion})` : "") +
    "…",
);

// Fresh build of everything: workspaces depend on each other, and the server
// imports the compiled packages, not their sources.
execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

fs.rmSync(outRoot, { recursive: true, force: true });
copyDir(path.join(repoRoot, "apps", "server", "dist"), path.join(outRoot, "apps", "server", "dist"));
copyDir(path.join(repoRoot, "apps", "web", "dist"), path.join(outRoot, "apps", "web", "dist"));

// The server's entry point, folded into one file together with every pure-JS
// dependency it imports (fastify, the AI SDK, drizzle, zod…). It lands at the
// same depth as the tree it replaces, which is what keeps `src/root.ts`'s hop to
// the package root — and so the web UI path, the data dir and the `.env` read —
// pointing where it did before. The compiled tree stays beside it so nothing
// that loads a file by path stops finding one.
await bundleEntry({
  from: path.join(repoRoot, "apps", "server", "dist", "index.js"),
  to: path.join(outRoot, "apps", "server", "dist", "index.js"),
  externals: BUNDLE_EXTERNALS,
});

// Bundled workspace packages: the copy npm embeds lives in the package's own
// node_modules, mirroring how the server resolves `@acpio/*` at runtime.
for (const name of WORKSPACE_PACKAGES) {
  const bundled = path.join(outRoot, "node_modules", "@acpio", name);
  copyDir(path.join(repoRoot, "packages", name, "dist"), path.join(bundled, "dist"));
  copyPackageAssets(name, bundled);
  const manifest = workspaceManifest(name, version);
  writeJson(path.join(bundled, "package.json"), manifest);

  // A package with registry dependencies of its own (the built-in adapter pulls
  // the AI SDK, minimatch and zod) has them folded into its own entry, because
  // its manifest ships no dependencies for the consumer's npm to read: without
  // this the install is one unresolved import away from a dead adapter. Its
  // `../skills` asset folder keeps resolving — the entry stays where it was.
  if (packageRegistryDeps(name).length) {
    await bundleEntry({
      from: path.join(repoRoot, "packages", name, manifest.main),
      to: path.join(bundled, manifest.main),
      externals: BUNDLE_EXTERNALS,
    });
  }
}

// The assets the two skill folders hang on: a build that lost them installs an
// app with no built-in skills at all, which is what this script shipped before.
for (const [pkg, folder] of [
  ["adapter-builtin", "skills"],
  ["plugin-ponytail", "skills"],
]) {
  const at = path.join(outRoot, "node_modules", "@acpio", pkg, folder);
  if (!fs.existsSync(at)) throw new Error(`${pkg}/${folder} did not travel into ${outRoot}`);
}

// Spawned tools travel as packages: `require.resolve` runs from the bundled
// `apps/server/dist/index.js`, which finds this copy the same way it found the
// registry one before.
for (const name of VENDORED_TOOLS) {
  const from = path.join(repoRoot, "node_modules", name);
  copyDir(from, path.join(outRoot, "node_modules", name));
  const at = path.join(outRoot, "node_modules", name, "lib", "cli.mjs");
  if (!fs.existsSync(at)) throw new Error(`${name} did not travel into ${outRoot}`);
}

// The stamp the shipped copy reports names this release, not the one git saw:
// the release run packs before it pushes its own tag, so the tag-derived
// `released` is the previous release — and an npm copy would show it in the
// header while `acpio -v` said the version that is actually installed.
if (!versionSuffix) {
  for (const file of ["buildInfo.js", "buildInfo.d.ts"]) {
    const stamped = path.join(outRoot, "node_modules", "@acpio", "shared", "dist", file);
    fs.writeFileSync(stamped, stampPackedRelease(fs.readFileSync(stamped, "utf8"), version));
  }
}

// postinstall: the node-pty (Windows/ConPTY) workarounds the repo applies after
// `npm install` must reach npm users too, or terminals leak child processes.
fs.mkdirSync(path.join(outRoot, "scripts"), { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, "scripts", "patch-node-pty.mjs"),
  path.join(outRoot, "scripts", "patch-node-pty.mjs"),
);

// CLI entry point, linked as the `acpio` binary on install.
fs.mkdirSync(path.join(outRoot, "bin"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "scripts", "npm-launcher.mjs"), path.join(outRoot, "bin", "acpio.mjs"));
for (const doc of ["README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(repoRoot, doc), path.join(outRoot, doc));
}

const workspaceDependencies = Object.fromEntries(
  WORKSPACE_PACKAGES.map((name) => [`@acpio/${name}`, version]),
);
// Pinned to the version the copy on disk actually carries: a range it did not
// satisfy would look "invalid" to npm and send it to the registry after a
// package that was never published there.
const vendoredDependencies = Object.fromEntries(
  VENDORED_TOOLS.map((name) => [
    name,
    readJson(path.join(repoRoot, "node_modules", name, "package.json")).version,
  ]),
);
writeJson(path.join(outRoot, "package.json"), {
  name: PKG_NAME,
  version,
  description:
    "Self-hosted web harness for agents speaking ACP (Cursor CLI / OMP / OpenCode) with a built-in agent: one process serves the web UI, the API and the WebSocket.",
  license: "MIT",
  type: "module",
  bin: { acpio: "bin/acpio.mjs" },
  engines: { node: ">=20" },
  repository: { type: "git", url: `git+${REPO_URL}.git` },
  homepage: `${REPO_URL}#readme`,
  bugs: { url: `${REPO_URL}/issues` },
  keywords: ["acp", "agent", "harness", "cursor", "omp", "opencode", "self-hosted"],
  scripts: { postinstall: "node scripts/patch-node-pty.mjs" },
  files: ["bin", "apps", "scripts", "README.md", "LICENSE"],
  dependencies: { ...runtimeDependencies(), ...workspaceDependencies, ...vendoredDependencies },
  bundledDependencies: [...WORKSPACE_PACKAGES.map((name) => `@acpio/${name}`), ...VENDORED_TOOLS],
});

console.log(`\nReady: ${outRoot} (${PKG_NAME}@${version})`);
console.log("Try it:   npm pack ./dist-npm && npm i -g ./acpio-" + version + ".tgz");
console.log("Publish:  npm publish ./dist-npm --access public");
