/**
 * Ensures production artifacts exist before `npm start`.
 * Fresh clones often run `npm install && npm start` without `npm run build`.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "packages/shared/dist/index.js",
  "packages/i18n/dist/index.js",
  "packages/adapter-cursor/dist/index.js",
  "packages/adapter-omp/dist/index.js",
  "apps/server/dist/index.js",
  "apps/web/dist/index.html",
];

const missing = required.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
if (missing.length === 0) {
  process.exit(0);
}

console.log("Production build missing — compiling before start:");
for (const rel of missing) console.log(`  - ${rel}`);
execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
