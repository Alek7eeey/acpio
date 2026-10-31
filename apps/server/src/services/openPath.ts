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
 * the default app for files). Each platform gets its own opener — `start` on
 * Windows, `open` on macOS, `xdg-open` elsewhere — because the click that asks
 * for it means the same thing on all three, and a host that cannot find one
 * says so in the log instead of pretending the window opened.
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
  // `exec` uses the shell, so the quoting lives in the command line itself.
  exec(openerCommand(kind, trimmed), (err) => {
    if (err) console.error("openPath exec error:", err.message);
  });
  return { ok: true, opened: trimmed, kind };
}

/** The shell line that hands `target` to this platform's default handler. */
function openerCommand(kind: "file" | "directory", target: string): string {
  if (process.platform === "win32") {
    // `start ""` with an empty title, so the path itself is not read as one.
    const winPath = target.replace(/\//g, "\\");
    return kind === "directory"
      ? `start "" explorer "${winPath}"`
      : `start "" explorer /select,"${winPath}"`;
  }
  // Single-quoted for the shell: a path may hold spaces or `$`.
  const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
  // Finder reveals a file in its folder; everything else hands the path to the
  // desktop's own handler, which is what the click meant anyway.
  if (process.platform === "darwin") {
    return kind === "directory" ? `open ${quoted}` : `open -R ${quoted}`;
  }
  return `xdg-open ${quoted}`;
}
