/**
 * The server the end-to-end suite runs against: the real production layout —
 * the built server process, serving the built web bundle on one port, on a
 * database of its own.
 *
 * Playwright starts this as its `webServer` (see playwright.config.ts) and
 * waits for /api/health before the first test, so everything below is part of
 * "the app is up": a clean database, the settings the specs assume, and the
 * fake agent registered and probed online.
 *
 * Run it by hand to poke at the suite's own instance:
 *
 *   node e2e/support/server.mjs      # http://127.0.0.1:18761
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  E2E_AGENT_ID,
  E2E_BASE_URL,
  E2E_DATA_DIR,
  E2E_PORT,
  E2E_SETTINGS,
  REPO_ROOT,
} from "./seed.mjs";

const SERVER_ENTRY = path.join(REPO_ROOT, "apps", "server", "dist", "index.js");
const WEB_ENTRY = path.join(REPO_ROOT, "apps", "web", "dist", "index.html");
const HEALTH = `${E2E_BASE_URL}/api/health`;
const DB_PATH = path.join(E2E_DATA_DIR, "acpio.db");

function missingBuild() {
  const missing = [
    fs.existsSync(SERVER_ENTRY) ? null : path.relative(REPO_ROOT, SERVER_ENTRY),
    fs.existsSync(WEB_ENTRY) ? null : path.relative(REPO_ROOT, WEB_ENTRY),
  ].filter(Boolean);
  return missing;
}

/** Poll until the app answers, or give up on a server that never came up. */
async function waitForHealth(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not answer ${HEALTH} within ${timeoutMs} ms`);
}

async function seed() {
  const settings = await fetch(`${E2E_BASE_URL}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(E2E_SETTINGS),
  });
  if (!settings.ok) {
    throw new Error(`seeding settings failed: ${settings.status} ${await settings.text()}`);
  }
  // Availability is the server's own memory of a successful probe: a chat may
  // only be created or prompted once the harness is online, so seed that too.
  const probe = await fetch(`${E2E_BASE_URL}/api/agent/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: E2E_AGENT_ID }),
  });
  if (!probe.ok) {
    throw new Error(`probing ${E2E_AGENT_ID} failed: ${probe.status} ${await probe.text()}`);
  }
  const online = await probe.json().catch(() => null);
  if (!online?.ok) {
    throw new Error(`the fake agent is not usable: ${JSON.stringify(online)}`);
  }
}

async function main() {
  const missing = missingBuild();
  if (missing.length) {
    console.error(
      `e2e: the build is missing (${missing.join(", ")}).\n` +
        "The suite drives the production bundle, so build it first:\n\n" +
        "  npm run build\n",
    );
    process.exit(1);
  }

  fs.rmSync(E2E_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(E2E_DATA_DIR, { recursive: true });

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_PATH: DB_PATH,
      ACPIO_PORT: String(E2E_PORT),
      HOST: "127.0.0.1",
      // A leftover PORT in the runner's environment must not move the server.
      PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Fastify logs a JSON object per request; a spec run makes thousands of them
  // and the suite's output is read by humans. Keep the plain lines (startup,
  // hooks) and anything the server itself calls a warning or an error.
  child.stdout.setEncoding("utf8");
  let rest = "";
  child.stdout.on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!line.trimStart().startsWith("{")) {
        console.log(line);
        continue;
      }
      try {
        if (JSON.parse(line).level >= 40) console.log(line);
      } catch {
        console.log(line);
      }
    }
  });
  child.stderr.pipe(process.stderr);

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stop(signal);
      process.exit(0);
    });
  }

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));

  await waitForHealth().catch((err) => {
    console.error(String(err));
    stop("SIGTERM");
    process.exit(1);
  });
  await seed().catch((err) => {
    console.error(String(err));
    stop("SIGTERM");
    process.exit(1);
  });
  console.log(`[e2e] ${E2E_BASE_URL} is up on ${path.relative(REPO_ROOT, DB_PATH)}`);

  process.exit(await exited);
}

void main();
