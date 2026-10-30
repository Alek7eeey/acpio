#!/usr/bin/env node
/**
 * `acpio` CLI — entry point of the npm package (scripts/package-npm.mjs copies
 * this file to dist-npm/bin/acpio.mjs, which npm links as the `acpio` binary;
 * `npm start` in the repo keeps running the server directly).
 *
 * Boots the bundled server: one process serves the web UI, the REST API and the
 * WebSocket on one port (18741 by default). `--version` / `--help` answer
 * without starting anything.
 *
 * The SQLite file is kept in a per-user directory rather than next to the code:
 * `npm i -g acpio@latest` replaces the package directory, and chats must survive
 * it. `DATABASE_PATH` (env, or the package's .env) still wins; `PORT` /
 * `ACPIO_PORT` / `HOST` keep their usual meaning.
 *
 * Installed: `npm i -g acpio` → `acpio`; one-off: `npx acpio`.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveServerPort } from "@acpio/shared";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
const args = process.argv.slice(2);

/** Per-user data dir, next to where the Windows installer keeps its data. */
function userDataDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "acpio");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "acpio");
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "acpio");
}

/** Does the app's .env set this variable itself? Then leave the default alone. */
function envFileSets(key) {
  const file = path.join(appDir, ".env");
  if (!fs.existsSync(file)) return false;
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(fs.readFileSync(file, "utf8"));
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser on this machine — the URL is printed anyway.
  }
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Acpio ${version} — self-hosted web harness for ACP agents.

Usage:
  acpio              start the server and open the web UI
  acpio --help       this text
  acpio --version    print the version

Starts one process serving the UI, the API and the WebSocket
(http://localhost:18741 by default).

Environment: ACPIO_PORT / PORT (default 18741), HOST (default 0.0.0.0),
DATABASE_PATH (default ${path.join(userDataDir(), "data", "acpio.db")}).`);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (!process.env.DATABASE_PATH && !envFileSets("DATABASE_PATH")) {
  const dataDir = path.join(userDataDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATABASE_PATH = path.join(dataDir, "acpio.db");
}

const port = resolveServerPort(process.env);
const url = `http://localhost:${port}`;
console.log(`Acpio ${version} — ${url}`);
console.log(`Data: ${process.env.DATABASE_PATH ?? "next to the app"}`);
if (!args.includes("--no-open")) {
  setTimeout(() => openBrowser(url), 1200).unref();
}

try {
  await import(pathToFileURL(path.join(appDir, "apps", "server", "dist", "index.js")).href);
} catch (err) {
  // npm 11.17+/12 skips install scripts unless the package is allowed, so
  // better-sqlite3 never fetches its prebuilt binary and the raw bindings
  // stack trace is the first thing a new user sees.
  if (!/better_sqlite3\.node|bindings file/.test(String(err?.stack ?? err))) throw err;
  console.error(`Acpio ${version}: the native SQLite module is missing — npm skipped install scripts.

Reinstall with them allowed:
  npm i -g acpio --allow-scripts=acpio,better-sqlite3,node-pty

(or for npx: npx --allow-scripts=acpio,better-sqlite3,node-pty acpio)`);
  process.exit(1);
}
