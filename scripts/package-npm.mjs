/**
 * Builds the publishable npm package `acpio` into dist-npm/:
 *
 *   dist-npm/package.json           generated manifest (bin, files, deps, bundle)
 *   dist-npm/bin/acpio.mjs          CLI — `npx acpio` / `npm i -g acpio`
 *   dist-npm/apps/server/dist/**    compiled server (it also serves the web UI)
 *   dist-npm/apps/web/dist/**       compiled web UI
 *   dist-npm/node_modules/@acpio/*  compiled workspace packages, bundled into the tarball
 *   dist-npm/scripts/…              node-pty patch, run by the package's postinstall
 *   dist-npm/README.md, LICENSE
 *
 * Layout mirrors the repo on purpose: the compiled server resolves its root with
 * fixed "../../.." hops (apps/server/dist/index.js → package root), so moving
 * the server deeper or shallower breaks the web UI path and the data dir.
 *
 * The workspace packages are not on the registry, so they travel *inside* the
 * tarball: they are copied to dist-npm/node_modules/@acpio/<name> and listed in
 * bundledDependencies, which makes `npm pack` / `npm publish` embed them and the
 * consumer's install resolve `@acpio/*` without a registry lookup. Their
 * manifest is regenerated at the release version (a bundled copy that disagreed
 * with the pinned range would look "invalid" and make npm try to fetch it).
 *
 * Registry dependencies are left to the consumer's install: better-sqlite3 and
 * node-pty then match their OS/arch, and this build stays platform-independent.
 *
 * Usage: npm run pack:npm [-- --expect-tag v0.1.37 | --version-suffix -rc.1]
 *   --expect-tag <tag>      fail unless the tag (leading "v" ignored) equals the
 *                           version git derives — the guard a tag release runs.
 *   --version-suffix <sfx>  publish as <derived><sfx>, e.g. 0.1.38-rc.7: a
 *                           prerelease of the current revision. It takes the
 *                           prerelease path because a new number cannot exist
 *                           twice in one commit day — this is how a build gets
 *                           verified on the registry without claiming the
 *                           release number (publish it under another dist-tag).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAppVersion, DEFAULT_VERSION_EPOCH } from "./versionHistory.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(repoRoot, "dist-npm");
const PKG_NAME = "acpio";
const REPO_URL = "https://github.com/Alek7eeey/acpio";

/** Workspace packages the compiled server imports at runtime (deps first). */
const WORKSPACE_PACKAGES = [
  "shared",
  "i18n",
  "adapter-cursor",
  "adapter-omp",
  "adapter-opencode",
  "adapter-builtin",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function git(cmd) {
  try {
    return execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
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

/** The same number git stamps into the repo (see scripts/versionHistory.mjs). */
function appVersion() {
  const pkg = readJson(path.join(repoRoot, "package.json"));
  const epochDate =
    typeof pkg.versionEpoch === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pkg.versionEpoch)
      ? pkg.versionEpoch
      : DEFAULT_VERSION_EPOCH;
  const commitDates = git("git log --format=%as HEAD").split("\n").filter(Boolean);
  if (commitDates.length === 0) {
    throw new Error(
      "Cannot derive the version: no git history here. Run `npm run pack:npm` inside the git checkout.",
    );
  }
  return computeAppVersion({ baseVersion: pkg.version, commitDates, epochDate });
}

/** Manifest of one bundled workspace package: dist only, pinned to the release version. */
function workspaceManifest(name, version) {
  const src = readJson(path.join(repoRoot, "packages", name, "package.json"));
  return {
    name: src.name,
    version,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    // No "development" condition: the bundle has no src/, so the built file is
    // the only entry point — exactly what a plain `node` run resolves.
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    },
  };
}

/** Registry deps of the server plus of every bundled workspace package (first spec wins). */
function registryDependencies() {
  const deps = {};
  const add = (from) => {
    for (const [name, spec] of Object.entries(from ?? {})) {
      if (name.startsWith("@acpio/")) continue;
      if (deps[name] === undefined) deps[name] = spec;
    }
  };
  add(readJson(path.join(repoRoot, "apps", "server", "package.json")).dependencies);
  for (const name of WORKSPACE_PACKAGES) {
    add(readJson(path.join(repoRoot, "packages", name, "package.json")).dependencies);
  }
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
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

const { version: derivedVersion, uniqueDays } = appVersion();
if (expectTag !== null && expectTag.replace(/^v/, "") !== derivedVersion) {
  console.error(
    `Tag ${expectTag} does not match the version git derives (${derivedVersion}, ${uniqueDays} commit day(s) since the epoch).`,
  );
  console.error(
    "The version is a function of git history — see VERSIONS.md for the number this revision carries.",
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

// Bundled workspace packages: the copy npm embeds lives in the package's own
// node_modules, mirroring how the server resolves `@acpio/*` at runtime.
for (const name of WORKSPACE_PACKAGES) {
  const bundled = path.join(outRoot, "node_modules", "@acpio", name);
  copyDir(path.join(repoRoot, "packages", name, "dist"), path.join(bundled, "dist"));
  writeJson(path.join(bundled, "package.json"), workspaceManifest(name, version));
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
  dependencies: { ...registryDependencies(), ...workspaceDependencies },
  bundledDependencies: WORKSPACE_PACKAGES.map((name) => `@acpio/${name}`),
});

console.log(`\nReady: ${outRoot} (${PKG_NAME}@${version})`);
console.log("Try it:   npm pack ./dist-npm && npm i -g ./acpio-" + version + ".tgz");
console.log("Publish:  npm publish ./dist-npm --access public");
