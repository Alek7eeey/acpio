import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
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
  /** Spawn time — a shell that dies sooner than this was never usable. */
  startedAt: number;
};

const consoles = new Map<string, ConsoleEntry>();
const attachInFlight = new Map<string, Promise<void>>();
const outputBuffers = new Map<
  string,
  { buf: string; timer: ReturnType<typeof setTimeout> | null }
>();
const OUTPUT_FLUSH_MS = 16;
/** A shell that dies sooner than this never worked, so restarting it would spin. */
const SHELL_EXIT_QUIET_MS = 1500;
/** The same limit for a revive after the console vanished under the panel. */
const REVIVE_COOLDOWN_MS = SHELL_EXIT_QUIET_MS;
/** Last revive per session, kept after release: a broken profile must not spawn per keystroke. */
const revivedAt = new Map<string, number>();

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

/** Console cwd must exist; a missing workspace falls back to the server's own directory. */
async function resolveConsoleRoot(cwd: string): Promise<string> {
  const root = path.resolve(cwd || process.cwd());
  try {
    await fs.access(root);
    return root;
  } catch {
    return process.cwd();
  }
}

async function resolveWindowsShell(
  shell: TerminalShell,
): Promise<{ file: string; args: string[] }> {
  if (shell === "powershell") {
    const pwsh7 = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    try {
      await fs.access(pwsh7);
      return { file: pwsh7, args: ["-NoLogo"] };
    } catch {
      // PowerShell 7 is not installed — use the in-box Windows PowerShell.
    }
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

async function shellCommand(kind: ConsoleShell): Promise<{ file: string; args: string[] }> {
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
    const { file, args } = await shellCommand(shell);
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cwd,
      env: await getConsoleEnv(),
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

async function spawnPipeBackend(cwd: string, shell: ConsoleShell): Promise<PtyLike> {
  const { file, args } = await shellCommand(shell);
  const child: ChildProcessWithoutNullStreams = spawn(file, args, {
    cwd,
    env: await getConsoleEnv(),
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
  const root = await resolveConsoleRoot(cwd);
  const backend =
    (await spawnPtyBackend(root, shell, initialSize)) ??
    (await spawnPipeBackend(root, shell));
  const entry: ConsoleEntry = { cwd: root, backend, shell, startedAt: Date.now() };
  consoles.set(sessionId, entry);
  // A replaced backend outlives its console: ConPTY teardown and killing the
  // process tree of a busy shell (`omp`, a build) take a while, so the late
  // output and exit of the shell that was just cleared must not touch the one
  // that took its place — that used to kill a fresh shell within milliseconds.
  backend.onData((chunk) => {
    if (consoles.get(sessionId) !== entry) return;
    pushOutput(sessionId, chunk);
  });
  backend.onExit(() => {
    if (consoles.get(sessionId) !== entry) return;
    releaseUserConsole(sessionId);
    // The shell is gone on its own (exit, crash, the app it ran tore the console
    // down). A panel that keeps swallowing keystrokes looks broken, so tell the
    // client to attach a fresh shell — unless it never got to work at all, where
    // a restart loop would only hide the failure.
    if (Date.now() - entry.startedAt >= SHELL_EXIT_QUIET_MS) {
      broadcastToSession(sessionId, { type: "process.cleared", sessionId });
    }
  });
}

/** Start a fresh interactive shell in the session workspace (reuse if already running). */
export async function attachUserConsole(
  sessionId: string,
  cwd: string,
  preferredShell?: TerminalShell,
  initialSize?: { cols?: number; rows?: number },
): Promise<void> {
  const shell = await resolveConsoleShell(preferredShell);
  const root = await resolveConsoleRoot(cwd);
  const existing = consoles.get(sessionId);
  if (existing && existing.shell === shell && existing.cwd === root) return;

  const pending = attachInFlight.get(sessionId);
  if (pending) return pending;

  const task = (async () => {
    const latestShell = await resolveConsoleShell(preferredShell);
    const latestRoot = await resolveConsoleRoot(cwd);
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

/** Write user input into the session shell; `false` when no shell is running there. */
export function writeUserConsole(sessionId: string, data: string): boolean {
  const entry = consoles.get(sessionId);
  if (!entry) return false;
  entry.backend.write(data);
  return true;
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
  // An attach that is still spawning owns the console: wait for it, otherwise the
  // kill lands on nothing and the spawn it raced sets the panel back to a shell
  // that was already released.
  const pending = attachInFlight.get(sessionId);
  if (pending) {
    try {
      await pending;
    } catch {
      /* a failed attach leaves no console to release */
    }
  }
  releaseUserConsole(sessionId);
  broadcastToSession(sessionId, { type: "process.cleared", sessionId });
  await attachUserConsole(sessionId, cwd);
}

/**
 * Start a shell after the one the panel was attached to vanished (server restart,
 * shell exited while nobody watched). The client is told to reset its screen and
 * attach, which is also what makes the keystroke that got here meaningful.
 */
export async function reviveUserConsole(sessionId: string, cwd: string): Promise<void> {
  const now = Date.now();
  if (now - (revivedAt.get(sessionId) ?? 0) < REVIVE_COOLDOWN_MS) return;
  revivedAt.set(sessionId, now);
  await attachUserConsole(sessionId, cwd);
  broadcastToSession(sessionId, { type: "process.cleared", sessionId });
}
