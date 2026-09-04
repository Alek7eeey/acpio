import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TerminalShell } from "@acpio/shared";
import { clampConsoleTerminalSize } from "@acpio/shared";
import { getConsoleEnv } from "./consoleEnv.js";
import { broadcastToSession } from "./wsHub.js";
import { getSettings } from "./settings.js";

type PtyLike = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: () => void) => void;
};

type ConsoleShell = TerminalShell | "unix";

type ConsoleEntry = {
  cwd: string;
  backend: PtyLike;
  shell: ConsoleShell;
};

const consoles = new Map<string, ConsoleEntry>();
const attachInFlight = new Map<string, Promise<void>>();
const outputBuffers = new Map<
  string,
  { buf: string; timer: ReturnType<typeof setTimeout> | null }
>();
const OUTPUT_FLUSH_MS = 16;

function flushOutputBuffer(sessionId: string) {
  const entry = outputBuffers.get(sessionId);
  if (!entry?.buf) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  const text = entry.buf;
  entry.buf = "";
  broadcastToSession(sessionId, { type: "process.output", sessionId, text, source: "shell" });
}

function pushOutput(sessionId: string, chunk: string) {
  if (!chunk || !consoles.has(sessionId)) return;
  let entry = outputBuffers.get(sessionId);
  if (!entry) {
    entry = { buf: "", timer: null };
    outputBuffers.set(sessionId, entry);
  }
  entry.buf += chunk;
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry!.timer = null;
    flushOutputBuffer(sessionId);
  }, OUTPUT_FLUSH_MS);
}

function resolveWindowsShell(shell: TerminalShell): { file: string; args: string[] } {
  if (shell === "powershell") {
    const pwsh7 = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    if (fs.existsSync(pwsh7)) return { file: pwsh7, args: ["-NoLogo"] };
    const winPs = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return { file: winPs, args: ["-NoLogo"] };
  }
  return { file: process.env.COMSPEC || "cmd.exe", args: [] };
}

function shellCommand(kind: ConsoleShell): { file: string; args: string[] } {
  if (kind === "unix") {
    const sh = process.env.SHELL || "/bin/bash";
    return { file: sh, args: ["-l"] };
  }
  return resolveWindowsShell(kind);
}

async function resolveConsoleShell(preferred?: TerminalShell): Promise<ConsoleShell> {
  if (process.platform !== "win32") return "unix";
  if (preferred === "powershell" || preferred === "cmd") return preferred;
  const settings = await getSettings();
  return settings.terminalShell === "powershell" ? "powershell" : "cmd";
}

async function spawnPtyBackend(
  cwd: string,
  shell: ConsoleShell,
  initialSize?: { cols?: number; rows?: number },
): Promise<PtyLike | null> {
  try {
    const pty = await import("node-pty");
    const { file, args } = shellCommand(shell);
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cwd,
      env: getConsoleEnv(),
      cols: clampConsoleTerminalSize({ cols: initialSize?.cols ?? 100, rows: 28 }).cols,
      rows: clampConsoleTerminalSize({ cols: 100, rows: initialSize?.rows ?? 28 }).rows,
    });
    return {
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: () => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
      },
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(cb),
    };
  } catch {
    return null;
  }
}

function spawnPipeBackend(cwd: string, shell: ConsoleShell): PtyLike {
  const { file, args } = shellCommand(shell);
  const child: ChildProcessWithoutNullStreams = spawn(file, args, {
    cwd,
    env: getConsoleEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });
  child.on("error", (err) => {
    console.error("Failed to spawn console shell:", err);
  });
  return {
    write: (data) => {
      if (child.stdin.writable) child.stdin.write(data);
    },
    resize: () => {
      /* pipe mode has no PTY resize */
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      child.stdout.on("data", (buf: Buffer) => cb(buf.toString("utf8")));
      child.stderr.on("data", (buf: Buffer) => cb(buf.toString("utf8")));
    },
    onExit: (cb) => child.on("exit", cb),
  };
}

async function spawnConsole(
  sessionId: string,
  cwd: string,
  shell: ConsoleShell,
  initialSize?: { cols?: number; rows?: number },
) {
  let root = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(root)) {
    root = process.cwd();
  }
  const backend =
    (await spawnPtyBackend(root, shell, initialSize)) ?? spawnPipeBackend(root, shell);
  const entry: ConsoleEntry = { cwd: root, backend, shell };
  consoles.set(sessionId, entry);
  backend.onData((chunk) => pushOutput(sessionId, chunk));
  backend.onExit(() => releaseUserConsole(sessionId));
}

/** Start a fresh interactive shell in the session workspace (reuse if already running). */
export async function attachUserConsole(
  sessionId: string,
  cwd: string,
  preferredShell?: TerminalShell,
  initialSize?: { cols?: number; rows?: number },
): Promise<void> {
  const shell = await resolveConsoleShell(preferredShell);
  let root = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(root)) {
    root = process.cwd();
  }
  const existing = consoles.get(sessionId);
  if (existing && existing.shell === shell && existing.cwd === root) return;

  const pending = attachInFlight.get(sessionId);
  if (pending) return pending;

  const task = (async () => {
    const latestShell = await resolveConsoleShell(preferredShell);
    let latestRoot = path.resolve(cwd || process.cwd());
    if (!fs.existsSync(latestRoot)) {
      latestRoot = process.cwd();
    }
    const current = consoles.get(sessionId);
    if (current && current.shell === latestShell && current.cwd === latestRoot) return;
    if (current) releaseUserConsole(sessionId);
    await spawnConsole(sessionId, cwd, latestShell, initialSize);
  })();

  attachInFlight.set(sessionId, task);
  try {
    await task;
  } finally {
    attachInFlight.delete(sessionId);
  }
}

export function writeUserConsole(sessionId: string, data: string) {
  consoles.get(sessionId)?.backend.write(data);
}

export function resizeUserConsole(sessionId: string, cols: number, rows: number) {
  const entry = consoles.get(sessionId);
  if (!entry) return;
  const size = clampConsoleTerminalSize({ cols, rows });
  entry.backend.resize(size.cols, size.rows);
}

export function releaseUserConsole(sessionId: string) {
  flushOutputBuffer(sessionId);
  outputBuffers.delete(sessionId);
  const entry = consoles.get(sessionId);
  if (!entry) return;
  entry.backend.kill();
  consoles.delete(sessionId);
}

/** Drop running shells whose profile no longer matches settings. */
export async function reconcileUserConsolesShell() {
  const shell = await resolveConsoleShell();
  for (const [sessionId, entry] of consoles) {
    if (entry.shell === shell) continue;
    releaseUserConsole(sessionId);
    broadcastToSession(sessionId, { type: "process.cleared", sessionId });
  }
}

/** Kill the shell and spawn a new one — initial state, no scrollback. */
export async function resetUserConsole(sessionId: string, cwd: string) {
  releaseUserConsole(sessionId);
  broadcastToSession(sessionId, { type: "process.cleared", sessionId });
  await attachUserConsole(sessionId, cwd);
}
