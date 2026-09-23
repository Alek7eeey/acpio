import fs from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";

export interface OpenPathResult {
  ok: boolean;
  opened: string;
  kind: "file" | "directory" | null;
  error?: string;
}

/**
 * Open a local path with the OS default handler (Explorer for directories,
 * the default app for files). No-op on non-Windows hosts: the harness UI
 * primarily runs against a Windows machine; other platforms get an honest
 * "unsupported" error instead of a silent no-op.
 */
export async function openPath(rawPath: string): Promise<OpenPathResult> {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0")) {
    return { ok: false, opened: "", kind: null, error: "invalid path" };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, opened: trimmed, kind: null, error: "path must be absolute" };
  }
  // A missing path and a path whose stat fails for any other reason (e.g. a
  // permission error) both report "path does not exist", like before.
  const stat = await fs.stat(trimmed).catch(() => null);
  if (!stat) {
    return { ok: false, opened: trimmed, kind: null, error: "path does not exist" };
  }
  const kind = stat.isDirectory() ? "directory" : "file";
  if (process.platform !== "win32") {
    return { ok: false, opened: trimmed, kind, error: "opening paths is supported on Windows only" };
  }
  // `start \"\"` with empty title opens the path with the default handler.
  // `exec` uses the shell and handles quoting correctly.
  const winPath = trimmed.replace(/\//g, "\\");
  const cmd = kind === "directory"
    ? `start "" explorer "${winPath}"`
    : `start "" explorer /select,"${winPath}"`;
  exec(cmd, (err) => {
    if (err) console.error("openPath exec error:", err.message);
  });
  return { ok: true, opened: trimmed, kind };
}
