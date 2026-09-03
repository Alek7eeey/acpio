/**
 * Builds a self-contained production bundle for Windows x64:
 *   dist-app/acpio-<version>-win-x64.zip
 *
 * Contents (all platform-specific pieces built on the current machine):
 *   server/        compiled server (apps/server/dist)
 *   web/           compiled web UI (apps/web/dist), served by the server
 *   packages/*     compiled workspace packages (shared, i18n, adapters)
 *   node_modules/  production deps (better-sqlite3 native binary included)
 *   start.cmd / start.sh
 *
 * Requires Node >= 20 (same platform as the target machine; the zip embeds
 * the native better-sqlite3 binary, so build on the OS/arch you distribute).
 *
 * Usage: npm run dist
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "dist-app");
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const pkgName = `acpio-${version}-win-x64`;
const pkgDir = path.join(distRoot, pkgName);
const isWindows = process.platform === "win32";

/** Copy a dir recursively, skipping node_modules and dist inside sources. */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Copy a built workspace package: dist output + package.json (for `file:` deps). */
function copyPackage(name) {
  const src = path.join(repoRoot, "packages", name);
  const dest = path.join(pkgDir, "packages", name);
  copyDir(path.join(src, "dist"), path.join(dest, "dist"));
  copyDir(src, dest); // package.json (dist/ is skipped by copyDir)
}

console.log(`Packaging ${pkgName}…`);

// 1. Fresh build of everything (workspaces depend on each other).
execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

// 2. Assemble layout. Mirror the repo's depth exactly (apps/server/dist,
// apps/web/dist) — the compiled code resolves its root with fixed
// "../../.."/"../../../../" hops that only match that depth.
fs.rmSync(pkgDir, { recursive: true, force: true });
copyDir(
  path.join(repoRoot, "apps", "server", "dist"),
  path.join(pkgDir, "apps", "server", "dist"),
);
copyDir(path.join(repoRoot, "apps", "web", "dist"), path.join(pkgDir, "apps", "web", "dist"));
for (const name of ["shared", "i18n", "adapter-omp", "adapter-cursor"]) {
  copyPackage(name);
}

// 3. Prod manifest: registry deps from the server + workspace file: deps.
const serverPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "apps", "server", "package.json"), "utf8"),
);
const dependencies = {};
for (const [name, ver] of Object.entries(serverPkg.dependencies)) {
  if (name.startsWith("@acpio/")) continue;
  dependencies[name] = ver;
}
for (const name of ["shared", "i18n", "adapter-omp", "adapter-cursor"]) {
  dependencies[`@acpio/${name}`] = `file:packages/${name}`;
}
fs.writeFileSync(
  path.join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: "acpio",
      version,
      private: true,
      type: "module",
      engines: { node: ">=20" },
      scripts: { start: "node apps/server/dist/index.js" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

// 4. Production deps (includes the native better-sqlite3 binary).
execSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", {
  cwd: pkgDir,
  stdio: "inherit",
});
// npm installs `file:` workspace deps as symlinks — zip/expand would turn
// them into empty dirs. Materialize them as real copies.
for (const name of ["shared", "i18n", "adapter-omp", "adapter-cursor"]) {
  const target = path.join(pkgDir, "node_modules", "@acpio", name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(pkgDir, "packages", name), target, { recursive: true });
}
fs.rmSync(path.join(pkgDir, "package-lock.json"), { force: true });

// 5. Launch scripts.
fs.writeFileSync(
  path.join(pkgDir, "start.cmd"),
  [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    "if not exist data mkdir data",
    'echo Starting Acpio at http://localhost:18741',
    'start "" http://localhost:18741',
    "node apps/server/dist/index.js",
    "",
  ].join("\r\n"),
);
fs.writeFileSync(
  path.join(pkgDir, "start.sh"),
  [
    "#!/usr/bin/env sh",
    'cd "$(dirname "$0")"',
    "mkdir -p data",
    "echo Starting Acpio at http://localhost:18741",
    '(xdg-open http://localhost:18741 >/dev/null 2>&1 || open http://localhost:18741 >/dev/null 2>&1) &',
    "exec node apps/server/dist/index.js",
    "",
  ].join("\n"),
);

// 6. Zip. Stable name (version-independent) so the "latest release" download
// URL works: https://github.com/Alek7eeey/acpio/releases/latest/download/acpio-win-x64.zip
const zipPath = path.join(distRoot, "acpio-win-x64.zip");
fs.rmSync(zipPath, { force: true });
if (isWindows) {
  // Compress-Archive can be slow on huge trees; node_modules first pass is
  // flaky with deep paths, so zip via PowerShell with the dir as root.
  const ps = [
    "$ErrorActionPreference='Stop'",
    `Compress-Archive -Path '${pkgDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -CompressionLevel Optimal`,
  ].join("; ");
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { cwd: distRoot, stdio: "inherit" });
} else {
  execSync(`zip -rq "${path.basename(zipPath)}" "${pkgName}"`, { cwd: distRoot, stdio: "inherit" });
}

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`\nDone: ${zipPath} (${sizeMb} MB)`);
console.log(`Unpack ${pkgName} and run start.cmd (Windows) or start.sh (macOS/Linux).`);
console.log("Node >= 20 is required on the target machine.");
