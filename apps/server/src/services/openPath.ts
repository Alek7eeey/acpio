import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
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
export function openPath(rawPath: string): OpenPathResult {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0")) {
    return { ok: false, opened: "", kind: null, error: "invalid path" };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, opened: trimmed, kind: null, error: "path must be absolute" };
  }
  if (!existsSync(trimmed)) {
    return { ok: false, opened: trimmed, kind: null, error: "path does not exist" };
  }
  const kind = statSync(trimmed).isDirectory() ? "directory" : "file";
  if (process.platform !== "win32") {
    return { ok: false, opened: trimmed, kind, error: "opening paths is supported on Windows only" };
  }
  // `explorer.exe` works reliably from background processes unlike `start`.
  const winPath = trimmed.replace(/\//g, "\\");
  const args = kind === "directory" ? [winPath] : ["/select," + winPath];
  const child = spawn("explorer.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { ok: true, opened: trimmed, kind };
}
