import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_INFO,
  isNewerVersion,
  parseVersion,
  type AppUpdateStateDto,
  type AppUpdateStatus,
} from "@acpio/shared";

/**
 * Acpio updates itself the way it was installed. There are three ways, and each
 * replaces the copy that is *running*: npm's package (and the npx cache, which
 * is one) reinstalls into its own prefix, a checkout of the sources pulls and
 * rebuilds, and the portable bundle downloads the release zip and is unpacked
 * over itself. The restart then starts that same copy again, which is the
 * moment the downloaded build actually runs.
 */

/** The package the app is published as — the one `npx acpio` and `npm i -g` fetch. */
const PACKAGE_NAME = "acpio";
/** Where the portable bundle is published: `<repo>/releases/download/v<version>/<asset>`. */
const REPO_SLUG = "Alek7eeey/acpio";
const BUNDLE_ASSET = "acpio-win-x64.zip";
/**
 * Where this build sits: `apps/server/{src,dist}/services/appUpdate.ts` is four
 * directories above the package root, the same hops `index.ts` takes for the UI.
 */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** Give up on a slow registry so the header's check cannot hang. */
const CHECK_TIMEOUT_MS = 10_000;
/** A version that answered is good for a quarter of an hour: one registry, many polls. */
const CHECK_TTL_MS = 15 * 60_000;
/** A failed check retries sooner — an offline laptop comes back — but not on every poll. */
const CHECK_FAILURE_TTL_MS = 60_000;
/** npm downloads the package, its deps and patches node-pty; five minutes is plenty. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** A pull of a checkout is one fetch; a minute covers a slow link. */
const GIT_PULL_TIMEOUT_MS = 2 * 60_000;
/** Installing a checkout's dependencies. */
const GIT_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Building a checkout: the server, the web bundle and the version stamp. */
const GIT_BUILD_TIMEOUT_MS = 10 * 60_000;
/** The whole portable bundle, 13 MB of it. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000;
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

/** How this copy of Acpio can be replaced by a newer one. */
export type UpdateKind = "npm" | "git" | "bundle" | "none";

/** Runs one shell command and keeps the tail of what it said. */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<InstallOutcome>;

/** The ways an install touches the world; every one of them is faked in the tests. */
export interface UpdateSeams {
  /** git, npm and the build of a checkout. */
  runCommand?: CommandRunner;
  /** Fetches the portable bundle to a file. */
  download?: (url: string, file: string) => Promise<void>;
  /** Unpacks it into the staging directory. */
  extract?: (zip: string, dir: string) => Promise<void>;
}

export interface AppUpdaterOptions extends UpdateSeams {
  /** Where `latest` is read from: a mirror, or the stub server in the tests. */
  registryUrl?: string;
  /** Runs the install; the tests hand it a fake instead of npm, git and the zip. */
  runInstall?: (version: string, prefix: string | null) => Promise<InstallOutcome>;
  /** This build's release number; `BUILD_INFO.released` unless a test says otherwise. */
  current?: string;
  /** How this copy is updated; read from the package root unless told. */
  kind?: UpdateKind;
  /** Whether this copy can update itself at all — `kind !== "none"` unless told. */
  selfUpdate?: boolean;
  /** The directory this build is installed in; the package root above `apps/server`. */
  appRoot?: string;
  /** The version the copy on disk reports, null when it cannot be read (tests). */
  readAppVersion?: (appRoot: string) => string | null;
  /** Clock for the cache (tests). */
  now?: () => number;
}

export interface AppUpdater {
  /** What the popup draws: both numbers, whether one is newer, install progress. */
  state(): Promise<AppUpdateStateDto>;
  /** Start installing; resolves as soon as the install is under way. */
  install(): Promise<AppUpdateStateDto>;
  /**
   * A downloaded build waiting for the restart to put it in place; null when
   * the install already replaced this copy where it stands.
   */
  pendingFiles(): string | null;
}

export function createAppUpdater(options: AppUpdaterOptions = {}): AppUpdater {
  const now = options.now ?? Date.now;
  const current = options.current ?? BUILD_INFO.released;
  const appRoot = options.appRoot ?? APP_ROOT;
  const registryUrl =
    options.registryUrl ?? process.env.ACPIO_UPDATE_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const kind = options.kind ?? updateKind(appRoot);
  const selfUpdate = options.selfUpdate ?? kind !== "none";
  /** The prefix `npm i -g` wrote this copy into, when it came from one. */
  const prefix = installPrefix(appRoot);
  const readVersion = options.readAppVersion ?? readAppVersion;
  const seams: Required<UpdateSeams> = {
    runCommand: options.runCommand ?? runShell,
    download: options.download ?? downloadFile,
    extract: options.extract ?? extractZip,
  };
  const runInstall =
    options.runInstall ??
    ((version: string, into: string | null) => installFor(kind, appRoot, version, into, seams));
  /** The bundle unpacked beside this copy, waiting for the restart. */
  let staged: string | null = null;

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
      selfUpdate,
      ...(message ? { message } : {}),
      checkedAt: cache ? new Date(cache.at).toISOString() : null,
    };
  }

  async function install(): Promise<AppUpdateStateDto> {
    const before = await state();
    // Two clicks on one button are one install, and nothing newer than this
    // build means nothing to download. A copy with no way to update itself has
    // no install to start at all — the button is not even offered to it.
    if (status === "installing" || !selfUpdate || !before.available || !before.latest) return before;
    const target = before.latest;
    status = "installing";
    message = undefined;
    // Deliberately not awaited: an install takes minutes, and the popup polls
    // `state()` while it runs.
    void runInstall(target, prefix)
      .then((outcome) => {
        if (outcome.code === 0) {
          // npm's exit code does not answer "did *this* copy change": a prefix
          // of its own leaves the running build untouched, and the restart
          // would bring back the very same version — exactly the update that
          // reports success and changes nothing. Only npm's own layout is
          // asked: a checkout and the bundle are not versioned by npm.
          const onDisk = kind === "npm" ? readVersion(appRoot) : null;
          if (onDisk && onDisk !== target) {
            status = "error";
            message =
              `acpio@${target} was installed, but this copy is still ${onDisk} — ` +
              `the update went to another location.`;
            return;
          }
          // The bundle was unpacked beside this copy: only the restart can put
          // it in place, since the files it replaces are the ones in use.
          staged = kind === "bundle" ? stagingDir(appRoot, target) : null;
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

  return { state, install, pendingFiles: () => staged };
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
 * The manifest of the copy that is running — the package root's `package.json`.
 * Null when there is none to read, which is itself an answer: not a copy npm
 * ever installed.
 */
function readAppManifest(appRoot: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Is this manifest the published `acpio` package — the one `npm i -g` replaces?
 * A checkout of the sources is `acpio` too but private and a workspace root, and
 * the portable bundle is `acprocess`: npm's download would land beside them.
 */
export function isNpmPackageManifest(pkg: unknown): boolean {
  if (!pkg || typeof pkg !== "object") return false;
  const manifest = pkg as { name?: unknown; private?: unknown; bin?: unknown };
  if (manifest.name !== PACKAGE_NAME || manifest.private === true) return false;
  const bin = manifest.bin as Record<string, unknown> | null | undefined;
  return Boolean(bin && typeof bin === "object" && typeof bin[PACKAGE_NAME] === "string");
}

/** Does this build sit where `npm i -g acpio` would have put it? */
export function isNpmPackage(appRoot: string): boolean {
  return isNpmPackageManifest(readAppManifest(appRoot));
}

/** The version the running copy reports on disk; null when unreadable. */
export function readAppVersion(appRoot: string): string | null {
  const pkg = readAppManifest(appRoot);
  const version = (pkg as { version?: unknown } | null)?.version;
  return typeof version === "string" ? version : null;
}

/**
 * The npm prefix this copy was installed under — the directory `npm i -g` wrote
 * it into. An install aimed there replaces the copy that is running; a plain
 * `npm i -g` follows whatever prefix the `npm` on PATH calls global, which on a
 * machine with two Node versions (nvm, fnm, a portable install) is another copy
 * entirely. Null when this build does not live in a `node_modules` at all.
 */
export function installPrefix(appRoot: string): string | null {
  const match = /^(.*)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(appRoot);
  if (!match) return null;
  const before = match[1];
  // npm keeps global packages in `<prefix>/lib/node_modules` on posix.
  const lib = /^(.*)[\\/]lib$/.exec(before);
  return lib ? lib[1] : before;
}

/**
 * One command through the shell, with its tail kept for the popup. A command
 * line rather than argv because `npm` on Windows is `npm.cmd` and `git` may be
 * a shim, which Node refuses to exec without a shell — and nothing a registry
 * says reaches it but a parsed version, so no answer of theirs runs a second
 * command.
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<InstallOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
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
    const timer = setTimeout(() => child.kill(), timeoutMs);
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

/**
 * `npm install -g acpio@<version>` in a child process, aimed at this copy's own
 * prefix when it has one.
 */
export function npmInstall(
  version: string,
  prefix: string | null = null,
  run: CommandRunner = runShell,
): Promise<InstallOutcome> {
  const command = installCommand(version, prefix);
  if (!command) return Promise.resolve({ code: 1, output: `not a version: ${version}` });
  return run(command, process.cwd(), INSTALL_TIMEOUT_MS);
}

/**
 * How this copy of Acpio is replaced: npm's package (which the npx cache also
 * is), a checkout of the sources, or the portable release bundle.
 */
export function updateKind(
  appRoot: string,
  platform: NodeJS.Platform = process.platform,
): UpdateKind {
  if (isNpmPackage(appRoot)) return "npm";
  if (existsSync(path.join(appRoot, ".git"))) return "git";
  // What is left and can be replaced whole is the portable bundle, which is
  // built for Windows x64 alone — the layout it unpacks over is its own.
  if (platform === "win32" && existsSync(path.join(appRoot, "apps", "server", "dist", "index.js"))) {
    return "bundle";
  }
  return "none";
}

/** The release zip of one version: what `irm setup.ps1` unpacks by hand. */
export function bundleUrl(version: string): string {
  const template = process.env.ACPIO_UPDATE_BUNDLE_URL;
  if (template) return template.replace("{version}", version);
  return `https://github.com/${REPO_SLUG}/releases/download/v${version}/${BUNDLE_ASSET}`;
}

/** Where a downloaded bundle waits for the restart: beside the copy it replaces. */
export function stagingDir(appRoot: string, version: string): string {
  return path.join(appRoot, `.update-${version}`);
}

/** The steps that bring a checkout of the sources up to the newest release. */
export const GIT_STEPS = [
  { command: "git pull --ff-only", timeoutMs: GIT_PULL_TIMEOUT_MS },
  { command: "npm install --no-audit --no-fund", timeoutMs: GIT_INSTALL_TIMEOUT_MS },
  { command: "npm run build", timeoutMs: GIT_BUILD_TIMEOUT_MS },
] as const;

/**
 * A checkout updates in place: pull the released sources, install what they
 * need and build them. `--ff-only` is the honest form of it — a tree with local
 * commits or uncommitted work is not something an update may merge over, and
 * git's own refusal is what the popup shows.
 */
export async function gitInstall(
  appRoot: string,
  run: CommandRunner = runShell,
): Promise<InstallOutcome> {
  let output = "";
  for (const step of GIT_STEPS) {
    const outcome = await run(step.command, appRoot, step.timeoutMs);
    output = (output + outcome.output).slice(-OUTPUT_KEEP);
    if (outcome.code !== 0) {
      return { code: outcome.code, output: `${step.command} failed\n${output}` };
    }
  }
  return { code: 0, output };
}

/**
 * The portable bundle updates by downloading the released zip and unpacking it
 * into a staging directory beside this copy: the files it replaces — the native
 * SQLite module above all — are the ones this process holds open, so only the
 * restart may swap them (see `restartScript`).
 */
export async function bundleInstall(
  appRoot: string,
  version: string,
  seams: Required<UpdateSeams>,
): Promise<InstallOutcome> {
  const url = bundleUrl(version);
  const staging = stagingDir(appRoot, version);
  const zip = `${staging}.zip`;
  try {
    await seams.download(url, zip);
    await seams.extract(zip, staging);
    return { code: 0, output: `unpacked ${url}` };
  } catch (err) {
    return { code: 1, output: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(zip, { force: true });
  }
}

/** The install one kind of copy makes; `none` has nothing to run. */
export function installFor(
  kind: UpdateKind,
  appRoot: string,
  version: string,
  prefix: string | null,
  seams: Required<UpdateSeams>,
): Promise<InstallOutcome> {
  if (kind === "npm") return npmInstall(version, prefix, seams.runCommand);
  if (kind === "git") return gitInstall(appRoot, seams.runCommand);
  if (kind === "bundle") return bundleInstall(appRoot, version, seams);
  return Promise.resolve({ code: 1, output: "this copy of Acpio has no update of its own" });
}

/** Fetch a file to disk; the bundle is the only thing large enough to need it. */
async function downloadFile(url: string, file: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * Unpack a release zip. There is no zip reader in Node itself and this app
 * ships no dependency for one; the bundle is Windows-only, and Windows has
 * `Expand-Archive` since PowerShell 5.
 */
async function extractZip(zip: string, dir: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("the portable bundle is published for Windows only");
  }
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const outcome = await runShell(
    `powershell -NoProfile -NonInteractive -Command ` +
      `"Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dir)} -Force"`,
    path.dirname(dir),
    BUNDLE_TIMEOUT_MS,
  );
  if (outcome.code !== 0) throw new Error(installFailure(outcome));
}

/**
 * The install line for a version from the registry, or null when it is not one.
 * `prefix` aims `npm i -g` at the place the running copy came from.
 */
export function installCommand(version: string, prefix: string | null = null): string | null {
  if (!parseVersion(version)) return null;
  const into = prefix ? `--prefix "${prefix.replace(/"/g, '""')}" ` : "";
  return `npm install -g ${PACKAGE_NAME}@${version} ${into}${INSTALL_SCRIPTS}`;
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
  /** A downloaded build to put in place first; null when the install was in place already. */
  applyFrom?: string | null;
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
  launch(restartScript(next.command, next.args, delayMs, process.cwd(), options.applyFrom ?? null));
  setTimeout(() => exit(0), Math.max(200, Math.floor(delayMs / 3))).unref();
  return true;
}

/**
 * The helper's body: `process.execPath` there is node itself, and the argv is
 * this process's — after `npm i -g` that path holds the new build, which is what
 * makes the restart an update.
 *
 * `applyFrom` is a downloaded portable bundle: the helper puts it in place once
 * this process is gone, because the files it replaces are the ones this process
 * holds open, and a running Windows process keeps its native modules locked.
 * The data directory and a local `.env` stay as they are: an update moves the
 * code, never the chats.
 */
export function restartScript(
  command: string,
  args: string[],
  delayMs: number,
  cwd: string = process.cwd(),
  applyFrom: string | null = null,
): string {
  return [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `setTimeout(() => {`,
    ...(applyFrom ? applySteps(applyFrom) : []),
    `  spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, {`,
    `    detached: true, stdio: "ignore", cwd: ${JSON.stringify(cwd)}, env: process.env,`,
    `  }).unref();`,
    `}, ${delayMs});`,
  ].join("\n");
}

/**
 * The helper's copy step: the staged build over the copy it replaces, which is
 * the directory the staging one sits in — where the running copy came from, not
 * wherever this process happened to be started.
 */
function applySteps(applyFrom: string): string[] {
  return [
    `  try {`,
    `    const from = ${JSON.stringify(applyFrom)};`,
    `    const to = path.dirname(from);`,
    `    const keep = new Set(["data", ".env", path.basename(from)]);`,
    `    for (const entry of fs.readdirSync(from)) {`,
    `      if (keep.has(entry)) continue;`,
    `      fs.rmSync(path.join(to, entry), { recursive: true, force: true });`,
    `      fs.cpSync(path.join(from, entry), path.join(to, entry), {`,
    `        recursive: true, force: true,`,
    `      });`,
    `    }`,
    `  } catch (err) {`,
    `    // The old build stays in place: the page reports the version it gets.`,
    `  }`,
  ];
}
