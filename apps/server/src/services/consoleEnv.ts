import { spawnSync } from "node:child_process";
import path from "node:path";

export type EnvMap = Record<string, string>;

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

function readWindowsEnvBlock(scope: "Machine" | "User"): EnvMap {
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
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: process.env,
    },
  );
  if (result.error || result.status !== 0) return {};
  return parseEnvDump(result.stdout ?? "");
}

/** Environment for the interactive user console (cached for the process lifetime). */
export function getConsoleEnv(): EnvMap {
  if (cached) return cached;
  cached = mergeConsoleEnv({
    processEnv: process.env,
    machine: process.platform === "win32" ? readWindowsEnvBlock("Machine") : undefined,
    user: process.platform === "win32" ? readWindowsEnvBlock("User") : undefined,
  });
  return cached;
}

export function resetConsoleEnvCache(): void {
  cached = null;
}
