// Process + workspace helpers shared by every bench driver.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** Kill a child and, on Windows, everything it spawned (agents shell out). */
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

/**
 * Run a command to completion with a wall-clock ceiling. Output is captured,
 * not streamed; a timed-out process is killed as a tree and reported as such.
 */
export function runProcess(cmd, args, { cwd, env, timeoutMs = 240_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: "", stderr: String(err), timedOut: false, spawnError: true, wallMs: 0 });
      return;
    }
    const limit = 2_000_000;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (d) => {
      if (stdout.length < limit) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 200_000) stderr += d;
    });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, wallMs: Date.now() - t0 });
    };
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
  });
}

/** Materialize a task's `fixture/` into a fresh workspace directory. */
export function makeWorkspace(taskDir, workRoot, label) {
  const ws = path.join(workRoot, label);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  const fixture = path.join(taskDir, "fixture");
  if (existsSync(fixture)) cpSync(fixture, ws, { recursive: true });
  return ws;
}

/** Copy the task's hidden verifier into the workspace and run it. */
export async function verifyWorkspace(taskDir, task, ws) {
  const verifyScript = path.join(taskDir, "verify.mjs");
  if (!existsSync(verifyScript)) return { ok: false, code: null, output: "verify.mjs missing" };
  cpSync(verifyScript, path.join(ws, "verify.mjs"));
  const res = await runProcess(
    process.execPath,
    ["verify.mjs", ...(task.verifyArgs ?? [])],
    { cwd: ws, timeoutMs: 60_000 },
  );
  const output = (res.stdout + res.stderr).trim().slice(-2000);
  return { ok: res.code === 0, code: res.code, output, timedOut: res.timedOut };
}

/** Files the agent left behind, relative to the workspace (for the report). */
export function changedFiles(ws) {
  try {
    return readdirSync(ws).filter((f) => f !== "verify.mjs");
  } catch {
    return [];
  }
}
