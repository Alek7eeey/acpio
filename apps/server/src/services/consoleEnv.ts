import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

export type EnvMap = Record<string, string>;

const execFileAsync = promisify(execFile);

const WINDOWS_IDENTITY_KEYS = [
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "LOGONSERVER",
  "SESSIONNAME",
] as const;

let cached: EnvMap | null = null;
let inflight: Promise<EnvMap> | null = null;
// Bumped by resetConsoleEnvCache so a load that started before the reset cannot
// install its stale result (or clear the promise of the load that replaced it).
let generation = 0;

/** Copy `process.env` into a plain string map (node-pty cannot read Node's env object). */
export function stringEnv(source: NodeJS.ProcessEnv): EnvMap {
  const out: EnvMap = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function pickPath(env: EnvMap): string {
  return env.Path ?? env.PATH ?? env.path ?? "";
}

/** Windows PATH is Machine, then User, then leftover entries from the parent process. */
export function mergeWindowsPath(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of parts) {
    for (const segment of block.split(";")) {
      const dir = segment.trim();
      if (!dir) continue;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out.join(";");
}

function restoreIdentity(target: EnvMap, processEnv: EnvMap) {
  for (const key of WINDOWS_IDENTITY_KEYS) {
    if (processEnv[key] !== undefined) target[key] = processEnv[key];
  }
}

export function mergeConsoleEnv(opts: {
  processEnv: NodeJS.ProcessEnv;
  machine?: EnvMap;
  user?: EnvMap;
  platform?: NodeJS.Platform;
}): EnvMap {
  const processEnv = stringEnv(opts.processEnv);
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return { ...processEnv, TERM: "xterm-256color", COLORTERM: "truecolor" };
  }

  const machine = opts.machine ?? {};
  const user = opts.user ?? {};
  const merged: EnvMap = { ...machine, ...processEnv, ...user };
  restoreIdentity(merged, processEnv);

  const pathValue = mergeWindowsPath(pickPath(machine), pickPath(user), pickPath(processEnv));
  if (pathValue) {
    merged.Path = pathValue;
    merged.PATH = pathValue;
  }

  merged.TERM = "xterm-256color";
  merged.COLORTERM = "truecolor";
  return merged;
}

function parseEnvDump(stdout: string): EnvMap {
  const out: EnvMap = {};
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function parseWindowsEnvDump(stdout: string): EnvMap {
  return parseEnvDump(stdout);
}

function readWindowsEnvBlock(scope: "Machine" | "User"): Promise<EnvMap> {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    "$ErrorActionPreference='Stop';" +
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    `$table=[Environment]::GetEnvironmentVariables('${scope}');` +
    "foreach($entry in $table.GetEnumerator()){" +
    "Write-Output(([string]$entry.Key)+'='+([string]$entry.Value))" +
    "}";
  return readEnvBlock(powershell, script);
}

/**
 * Reading the registry blocks costs a PowerShell startup, so it must not run
 * synchronously: a blocked event loop here freezes every session for the whole
 * shell launch.
 */
async function readEnvBlock(powershell: string, script: string): Promise<EnvMap> {
  try {
    const { stdout } = await execFileAsync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: process.env,
      },
    );
    return parseEnvDump(stdout);
  } catch {
    // Missing PowerShell, non-zero exit or the 15 s timeout: fall back to process.env only.
    return {};
  }
}

/** Loads both registry blocks at once, then folds them over `process.env`. */
async function loadConsoleEnv(): Promise<EnvMap> {
  if (process.platform !== "win32") return mergeConsoleEnv({ processEnv: process.env });
  // Machine and User are independent reads — run them together so the first
  // attach pays one PowerShell startup instead of two.
  const [machine, user] = await Promise.all([
    readWindowsEnvBlock("Machine"),
    readWindowsEnvBlock("User"),
  ]);
  return mergeConsoleEnv({ processEnv: process.env, machine, user });
}

/** Environment for the interactive user console (cached for the process lifetime). */
export function getConsoleEnv(): Promise<EnvMap> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    const gen = generation;
    inflight = loadConsoleEnv()
      .then((env) => {
        if (gen === generation) cached = env;
        return env;
      })
      .finally(() => {
        if (gen === generation) inflight = null;
      });
  }
  // Concurrent first calls share this promise, so PowerShell is spawned once.
  return inflight;
}

export function resetConsoleEnvCache(): void {
  cached = null;
  generation += 1;
  // The load already running belongs to the previous generation: drop it so the
  // next call starts a fresh read instead of awaiting a stale one.
  inflight = null;
}
