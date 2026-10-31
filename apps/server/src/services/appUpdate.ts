import { spawn } from "node:child_process";
import {
  BUILD_INFO,
  isNewerVersion,
  parseVersion,
  type AppUpdateStateDto,
  type AppUpdateStatus,
} from "@acpio/shared";

/**
 * Acpio updates itself the way it was installed: the app is published as this
 * npm package, and `npm i -g acpio@latest` is what its README tells a user to
 * run — so the header's button runs the same command and then restarts the
 * process, which is the moment the downloaded build actually starts.
 */

/** The package the app is published as — the one `npx acpio` and `npm i -g` fetch. */
const PACKAGE_NAME = "acpio";
const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** Give up on a slow registry so the header's check cannot hang. */
const CHECK_TIMEOUT_MS = 10_000;
/** A version that answered is good for a quarter of an hour: one registry, many polls. */
const CHECK_TTL_MS = 15 * 60_000;
/** A failed check retries sooner — an offline laptop comes back — but not on every poll. */
const CHECK_FAILURE_TTL_MS = 60_000;
/** npm downloads the package, its deps and patches node-pty; five minutes is plenty. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** How much of npm's output is kept for the popup's error line. */
const OUTPUT_KEEP = 4_000;
/**
 * The packages whose install scripts build a native module, named as npm wants
 * them: since 11.17 npm runs no install script unless it is told which packages
 * may, and an update that skips better-sqlite3's leaves a build without its
 * SQLite binary — the next start then dies on the very first query.
 */
const INSTALL_SCRIPTS = "--allow-scripts=acpio,better-sqlite3,node-pty";

/** How an install ended: npm's exit code and the tail of what it said. */
export interface InstallOutcome {
  code: number;
  output: string;
}

export interface AppUpdaterOptions {
  /** Where `latest` is read from: a mirror, or the stub server in the tests. */
  registryUrl?: string;
  /** Runs the install; the tests hand it a fake instead of touching npm. */
  runInstall?: (version: string) => Promise<InstallOutcome>;
  /** This build's release number; `BUILD_INFO.released` unless a test says otherwise. */
  current?: string;
  /** Clock for the cache (tests). */
  now?: () => number;
}

export interface AppUpdater {
  /** What the popup draws: both numbers, whether one is newer, install progress. */
  state(): Promise<AppUpdateStateDto>;
  /** Start installing; resolves as soon as the install is under way. */
  install(): Promise<AppUpdateStateDto>;
}

export function createAppUpdater(options: AppUpdaterOptions = {}): AppUpdater {
  const now = options.now ?? Date.now;
  const current = options.current ?? BUILD_INFO.released;
  const registryUrl =
    options.registryUrl ?? process.env.ACPIO_UPDATE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const runInstall = options.runInstall ?? npmInstall;

  /** The last registry answer and when it arrived; a failure is cached too. */
  let cache: { latest: string | null; at: number } | null = null;
  let pending: Promise<string | null> | null = null;
  let status: AppUpdateStatus = "idle";
  let message: string | undefined;

  async function readRegistry(): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch(registryUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    try {
      const body = (await res.json()) as { version?: unknown };
      const version = typeof body?.version === "string" ? body.version.trim() : "";
      // A registry answer that is not a version is no answer: nothing to show
      // in the popup, and nothing npm could be asked to install.
      return parseVersion(version) ? version : null;
    } catch {
      return null;
    }
  }

  async function latestVersion(): Promise<string | null> {
    const ttl = cache?.latest ? CHECK_TTL_MS : CHECK_FAILURE_TTL_MS;
    if (cache && now() - cache.at < ttl) return cache.latest;
    if (!pending) {
      pending = readRegistry()
        .then((latest) => {
          cache = { latest, at: now() };
          return latest;
        })
        .catch(() => {
          cache = { latest: null, at: now() };
          return null;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  async function state(): Promise<AppUpdateStateDto> {
    const latest = await latestVersion();
    return {
      current,
      latest,
      available: latest !== null && isNewerVersion(latest, current),
      status,
      ...(message ? { message } : {}),
      checkedAt: cache ? new Date(cache.at).toISOString() : null,
    };
  }

  async function install(): Promise<AppUpdateStateDto> {
    const before = await state();
    // Two clicks on one button are one install, and nothing newer than this
    // build means nothing to download.
    if (status === "installing" || !before.available || !before.latest) return before;
    const target = before.latest;
    status = "installing";
    message = undefined;
    // Deliberately not awaited: an install takes minutes, and the popup polls
    // `state()` while npm works.
    void runInstall(target)
      .then((outcome) => {
        if (outcome.code === 0) {
          status = "done";
          // The registry answer this install was made from is what the process
          // will run after the restart — the same answer cannot be an update again.
          cache = { latest: target, at: now() };
          return;
        }
        status = "error";
        message = installFailure(outcome);
      })
      .catch((err: unknown) => {
        status = "error";
        message = err instanceof Error ? err.message : String(err);
      });
    return { ...before, status: "installing", message: undefined };
  }

  return { state, install };
}

/** The last few lines npm said, for the popup's error branch. */
export function installFailure(outcome: InstallOutcome): string {
  const lines = outcome.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-3).join("\n") || `npm exited with code ${outcome.code}`;
}

/**
 * `npm install -g acpio@<version>` in a child process. A command line rather
 * than argv because `npm` on Windows is `npm.cmd`, which Node refuses to exec
 * without a shell — and only a parsed version reaches the shell, so nothing a
 * registry says can carry a second command with it.
 */
export function npmInstall(version: string): Promise<InstallOutcome> {
  return new Promise((resolve) => {
    const command = installCommand(version);
    if (!command) {
      resolve({ code: 1, output: `not a version: ${version}` });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, npm_config_yes: "true", npm_config_update_notifier: "false" },
      });
    } catch (err) {
      resolve({ code: 1, output: err instanceof Error ? err.message : String(err) });
      return;
    }
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_KEEP);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    child.on("error", (err) => {
      output += `\n${err instanceof Error ? err.message : String(err)}`;
      settle(1);
    });
    child.on("close", (code) => settle(code ?? 1));
  });
}

/** The install line for a version from the registry, or null when it is not one. */
export function installCommand(version: string): string | null {
  if (!parseVersion(version)) return null;
  return `npm install -g ${PACKAGE_NAME}@${version} ${INSTALL_SCRIPTS}`;
}

export interface RestartOptions {
  /** The command line to repeat; defaults to this process's own. */
  argv?: string[];
  /** Node flags this process was started with (`process.execArgv`). */
  execArgv?: string[];
  /** Starts the helper that waits for our port and lock to be free; tests spy on it. */
  launch?: (script: string) => void;
  /** Leaves this process; tests spy on it. */
  exit?: (code: number) => void;
  /** How long the helper waits before starting the successor. */
  delayMs?: number;
}

/**
 * The command line that starts this server again. `tsx` runs the sources
 * directly and rewrites `process.argv` down to the bare entry, so the flags it
 * was started with are not recoverable — a TypeScript entry is repeated through
 * the same loader instead, which is what `npm run dev` needs.
 */
export function restartCommand(
  argv: string[],
  execArgv: string[] = [],
): { command: string; args: string[] } | null {
  if (argv.length === 0) return null;
  const [entry, ...rest] = argv;
  const typescript = /\.(?:ts|tsx|mts|cts)$/i.test(entry);
  return {
    command: process.execPath,
    args: [
      ...execArgv,
      ...(typescript ? ["--import", "tsx", "--conditions=development"] : []),
      entry,
      ...rest,
    ],
  };
}

/**
 * Hand the server over to the freshly installed build: a detached helper waits
 * for the port and the SQLite lock to be released, then starts the same command
 * line again. A direct spawn would lose the race — the new process would find
 * the port and the database still held by the one that is exiting.
 */
export function restartServer(options: RestartOptions = {}): boolean {
  const argv = options.argv ?? process.argv.slice(1);
  const execArgv = options.execArgv ?? process.execArgv;
  const delayMs = options.delayMs ?? 1_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const launch =
    options.launch ??
    ((script: string) => {
      spawn(process.execPath, ["-e", script], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
        env: process.env,
      }).unref();
    });
  // No command line to repeat under `node -e` or a test runner: never exit on a
  // host that has no server to bring back.
  const next = restartCommand(argv, execArgv);
  if (!next) return false;
  launch(restartScript(next.command, next.args, delayMs, process.cwd()));
  setTimeout(() => exit(0), Math.max(200, Math.floor(delayMs / 3))).unref();
  return true;
}

/**
 * The helper's body: `process.execPath` there is node itself, and the argv is
 * this process's — after `npm i -g` that path holds the new build, which is what
 * makes the restart an update.
 */
export function restartScript(
  command: string,
  args: string[],
  delayMs: number,
  cwd: string = process.cwd(),
): string {
  return [
    'const { spawn } = require("node:child_process");',
    `setTimeout(() => {`,
    `  spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, {`,
    `    detached: true, stdio: "ignore", cwd: ${JSON.stringify(cwd)}, env: process.env,`,
    `  }).unref();`,
    `}, ${delayMs});`,
  ].join("\n");
}
