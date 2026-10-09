// Workspace search for in-process agents. The builtin agent asks over JSON-RPC
// (`fs/glob`, `fs/search`) exactly like it asks for `fs/read_text_file`, so the
// file walk lives here rather than in the agent package — one implementation,
// already rooted in the session cwd the other fs/* methods enforce.
import fsp from "node:fs/promises";
import path from "node:path";

/** Directories no search should descend into: package dumps and build output. */
const SKIP_DIRS = new Set([
  ".git",
  ".tmp",
  ".cache",
  ".turbo",
  ".next",
  "node_modules",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

/** A single file over this size is not worth reading for a line match. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_GLOB_RESULTS = 500;
const MAX_SEARCH_RESULTS = 200;
/** Hard ceiling on files visited, so a wrong pattern cannot hang a turn. */
const MAX_FILES_SCANNED = 20_000;
const MAX_LINE_PREVIEW = 250;
const MAX_PATTERN_LENGTH = 500;

export interface GlobRequest {
  root: string;
  pattern: string;
  maxResults?: number;
}

export interface SearchRequest {
  root: string;
  /** Directory to search in, absolute and already checked against the cwd. */
  dir?: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** `**` crosses directory separators, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < norm.length; i++) {
    const char = norm[i]!;
    if (char === "*") {
      if (norm[i + 1] === "*") {
        i += 1;
        if (norm[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesGlob(relPath: string, pattern: string, matcher: RegExp): boolean {
  if (matcher.test(relPath)) return true;
  // A pattern without a separator is a filename pattern: `*.ts` should find
  // `src/a.ts` too.
  return !pattern.includes("/") && matcher.test(relPath.slice(relPath.lastIndexOf("/") + 1));
}

interface WalkEntry {
  /** Absolute path. */
  abs: string;
  /** Slash-separated path relative to the walk root. */
  rel: string;
}

/**
 * Depth-first walk that yields files only, skipping the heavy directories and
 * never following a symlink (a link back up the tree would loop forever).
 */
async function* walkFiles(root: string): AsyncGenerator<WalkEntry> {
  const pending: WalkEntry[] = [{ abs: root, rel: "" }];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, keep the rest of the walk
    }
    for (const entry of entries) {
      const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
        pending.push({ abs: path.join(dir.abs, entry.name), rel });
      } else if (entry.isFile()) {
        yield { abs: path.join(dir.abs, entry.name), rel };
      }
    }
  }
}

/** Workspace files whose path matches `pattern`, relative and sorted. */
export async function globFiles(
  req: GlobRequest,
): Promise<{ files: string[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(req.maxResults ?? MAX_GLOB_RESULTS, MAX_GLOB_RESULTS));
  const pattern = req.pattern.trim().replace(/\\/g, "/");
  if (!pattern) return { files: [], truncated: false };
  const matcher = globToRegExp(pattern);
  const files: string[] = [];
  let truncated = false;
  for await (const entry of walkFiles(req.root)) {
    if (!matchesGlob(entry.rel, pattern, matcher)) continue;
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    files.push(entry.rel);
  }
  files.sort();
  return { files, truncated };
}

/** Matches of `pattern` (a JavaScript regex) across text files, line by line. */
export async function searchFiles(
  req: SearchRequest,
): Promise<{ hits: SearchHit[]; truncated: boolean; filesScanned: number }> {
  const limit = Math.max(1, Math.min(req.maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
  const source = req.pattern.trim().slice(0, MAX_PATTERN_LENGTH);
  if (!source) return { hits: [], truncated: false, filesScanned: 0 };
  let matcher: RegExp;
  try {
    matcher = new RegExp(source, req.ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(
      `Некорректное регулярное выражение: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fileGlob = req.glob?.trim().replace(/\\/g, "/") ?? "";
  const fileMatcher = fileGlob ? globToRegExp(fileGlob) : null;
  const hits: SearchHit[] = [];
  let truncated = false;
  let filesScanned = 0;

  for await (const entry of walkFiles(req.dir ?? req.root)) {
    if (fileMatcher && !matchesGlob(entry.rel, fileGlob, fileMatcher)) continue;
    filesScanned += 1;
    if (filesScanned > MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }
    const text = await readTextFile(entry.abs);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!matcher.test(line)) continue;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const shown = line.trim();
      hits.push({
        path: entry.rel,
        line: i + 1,
        text: shown.length > MAX_LINE_PREVIEW ? `${shown.slice(0, MAX_LINE_PREVIEW)}…` : shown,
      });
    }
    if (truncated && hits.length >= limit) break;
  }
  // Walk order is filesystem order; a stable path/line order reads better in
  // the transcript and keeps the tool output reproducible.
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { hits, truncated, filesScanned };
}

/** `null` for a binary or oversized file — neither can produce a line match. */
async function readTextFile(file: string): Promise<string | null> {
  try {
    const stats = await fsp.stat(file);
    if (stats.size > MAX_FILE_BYTES) return null;
    const buf = await fsp.readFile(file);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
