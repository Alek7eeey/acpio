import fs from "node:fs";
import path from "node:path";
import { defaultPickerPath } from "./pickDirectory.js";

export type BrowseDirectoryEntry = {
  name: string;
  path: string;
};

export type BrowseDirectoryResult = {
  path: string;
  parent: string | null;
  entries: BrowseDirectoryEntry[];
  /** Virtual Windows “This PC” view with drive letters. */
  kind?: "drives" | "directory";
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

/** List subdirectories for in-browser folder picking (mobile / remote). */
export function browseDirectory(raw?: string): BrowseDirectoryResult {
  if (isDrivesRootRequest(raw)) {
    return {
      path: WINDOWS_DRIVES_ROOT,
      parent: null,
      kind: "drives",
      entries: listWindowsDrives(),
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
      if (!fs.statSync(full).isDirectory()) continue;
      entries.push({ name, path: full });
    } catch {
      // skip unreadable entries
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return { path: current, parent, kind: "directory", entries };
}
