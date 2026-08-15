import fs from "node:fs";
import path from "node:path";
import { defaultPickerPath } from "./pickDirectory.js";

export type BrowseDirectoryEntry = {
  name: string;
  path: string;
  isDir?: boolean;
  size?: number;
};

export type BrowseDirectoryResult = {
  path: string;
  parent: string | null;
  entries: BrowseDirectoryEntry[];
  /** Virtual Windows “This PC” view with drive letters. */
  kind?: "drives" | "directory";
  /** Standard user folders (Desktop, Downloads, …) for quick access. */
  quick?: BrowseDirectoryEntry[];
};

/** Virtual root for Windows drive list (This PC). */
export const WINDOWS_DRIVES_ROOT = "Computer";

function isWindowsDriveRoot(dir: string): boolean {
  const normalized = path.resolve(dir);
  return /^[a-zA-Z]:\\$/.test(normalized);
}

function listWindowsDrives(): BrowseDirectoryEntry[] {
  const entries: BrowseDirectoryEntry[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (!fs.existsSync(root)) continue;
      fs.readdirSync(root);
      entries.push({ name: `${letter}:`, path: root });
    } catch {
      // skip missing / inaccessible drives
    }
  }
  return entries;
}

function resolveBrowsePath(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return defaultPickerPath();
  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error("Path not found");
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Not a directory");
  }
  return resolved;
}

function isDrivesRootRequest(raw?: string): boolean {
  if (process.platform !== "win32") return false;
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return false;
  return (
    trimmed === WINDOWS_DRIVES_ROOT ||
    trimmed === "This PC" ||
    trimmed === "Этот компьютер" ||
    trimmed === "\\"
  );
}

/** Standard per-user folders for quick access (Desktop, Downloads, …).
 *  On Linux/macOS the XDG user dirs are honored, so localized folder names
 *  (e.g. ~/Загрузки) are found; only folders that exist are listed. */
function quickAccessFolders(): BrowseDirectoryEntry[] {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (!home) return [];
  const candidates: Array<{ name: string; path: string }> = [];
  if (process.platform !== "win32") {
    const dirsFile = path.join(home, ".config", "user-dirs.dirs");
    const labels: Record<string, string> = {
      DESKTOP: "Desktop",
      DOWNLOAD: "Downloads",
      DOCUMENTS: "Documents",
      PICTURES: "Pictures",
      MUSIC: "Music",
      VIDEOS: "Videos",
    };
    try {
      const text = fs.readFileSync(dirsFile, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^XDG_([A-Z_]+)_DIR="([^"]*)"/);
        if (!m) continue;
        const label = labels[m[1]];
        if (!label) continue;
        let dir = m[2].replace("$HOME", home);
        if (!path.isAbsolute(dir)) dir = path.join(home, dir);
        candidates.push({ name: label, path: dir });
      }
    } catch {
      // no config — fall through to defaults
    }
  }
  const seen = new Set(candidates.map((c) => c.path.toLowerCase()));
  for (const name of ["Desktop", "Downloads", "Documents", "Pictures", "Music", "Videos"]) {
    const full = path.join(home, name);
    if (!seen.has(full.toLowerCase())) candidates.push({ name, path: full });
  }
  const out: BrowseDirectoryEntry[] = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path) && fs.statSync(c.path).isDirectory()) {
        out.push({ name: c.name, path: c.path, isDir: true });
      }
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/** List subdirectories (and optionally files) for in-browser picking (mobile / remote). */
export function browseDirectory(
  raw?: string,
  opts?: { includeFiles?: boolean },
): BrowseDirectoryResult {
  if (isDrivesRootRequest(raw)) {
    return {
      path: WINDOWS_DRIVES_ROOT,
      parent: null,
      kind: "drives",
      entries: listWindowsDrives(),
      quick: quickAccessFolders(),
    };
  }

  const current = resolveBrowsePath(raw);
  let parent: string | null = null;
  const parentDir = path.dirname(current);

  if (process.platform === "win32" && isWindowsDriveRoot(current)) {
    parent = WINDOWS_DRIVES_ROOT;
  } else if (parentDir !== current) {
    parent = parentDir;
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(current);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read directory: ${message}`);
  }

  const entries: BrowseDirectoryEntry[] = [];
  for (const name of names) {
    if (!name || name === "." || name === "..") continue;
    if (name.startsWith(".")) continue;
    const full = path.join(current, name);
    try {
      if (fs.statSync(full).isDirectory()) {
        entries.push({ name, path: full, isDir: true });
      } else if (opts?.includeFiles) {
        entries.push({ name, path: full, isDir: false, size: fs.statSync(full).size });
      }
    } catch {
      // skip unreadable entries
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return { path: current, parent, kind: "directory", entries, quick: quickAccessFolders() };
}
