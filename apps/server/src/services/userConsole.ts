import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { broadcastToSession } from "./wsHub.js";

type PtyLike = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: () => void) => void;
};

type ConsoleEntry = {
  cwd: string;
  backend: PtyLike;
};

const consoles = new Map<string, ConsoleEntry>();
const attachInFlight = new Map<string, Promise<void>>();

function pushOutput(sessionId: string, chunk: string) {
  if (!chunk) return;
  if (!consoles.has(sessionId)) return;
  broadcastToSession(sessionId, { type: "process.output", sessionId, text: chunk, source: "shell" });
}

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC || "cmd.exe", args: [] };
  }
  const sh = process.env.SHELL || "/bin/bash";
  return { file: sh, args: ["-l"] };
}

async function spawnPtyBackend(cwd: string): Promise<PtyLike | null> {
  try {
    const pty = await import("node-pty");
    const { file, args } = shellCommand();
    const proc = pty.spawn(file, args, {
      name: "xterm-256color",
      cwd,
      env: process.env as Record<string, string>,
      cols: 100,
      rows: 28,
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

function spawnPipeBackend(cwd: string): PtyLike {
  const { file, args } = shellCommand();
  const child: ChildProcessWithoutNullStreams = spawn(file, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
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

async function spawnConsole(sessionId: string, cwd: string) {
  const root = path.resolve(cwd || process.cwd());
  const backend = (await spawnPtyBackend(root)) ?? spawnPipeBackend(root);
  const entry: ConsoleEntry = { cwd: root, backend };
  consoles.set(sessionId, entry);
  backend.onData((chunk) => pushOutput(sessionId, chunk));
  backend.onExit(() => releaseUserConsole(sessionId));
}

/** Start a fresh interactive shell in the session workspace (no reuse). */
export async function attachUserConsole(sessionId: string, cwd: string): Promise<void> {
  const pending = attachInFlight.get(sessionId);
  if (pending) return pending;

  const task = (async () => {
    releaseUserConsole(sessionId);
    await spawnConsole(sessionId, cwd);
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
  const c = Math.max(20, Math.min(240, Math.round(cols)));
  const r = Math.max(5, Math.min(80, Math.round(rows)));
  entry.backend.resize(c, r);
}

export function releaseUserConsole(sessionId: string) {
  const entry = consoles.get(sessionId);
  if (!entry) return;
  entry.backend.kill();
  consoles.delete(sessionId);
}

/** Kill the shell and spawn a new one — initial state, no scrollback. */
export async function resetUserConsole(sessionId: string, cwd: string) {
  releaseUserConsole(sessionId);
  broadcastToSession(sessionId, { type: "process.cleared", sessionId });
  await attachUserConsole(sessionId, cwd);
}
