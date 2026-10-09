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
/**
 * …unless the model named that file: an explicit target is searched whatever its
 * size, with this as the ceiling past which even the answer would not fit.
 */
const NAMED_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Skipped paths the result names (the count itself is always complete). */
const SKIPPED_FILES_LIST_CAP = 20;
/** Text the result shows for a match — a window around it, not the line start. */
const MATCH_CONTEXT_CHARS = 500;
const MAX_GLOB_RESULTS = 500;
const MAX_SEARCH_RESULTS = 200;
/** Hard ceiling on files visited, so a wrong pattern cannot hang a turn. */
const MAX_FILES_SCANNED = 20_000;
const MAX_LINE_PREVIEW = 250;
const MAX_PATTERN_LENGTH = 500;

export interface GlobRequest {
  root: string;
  /**
   * Folder the reported paths are relative to — the session cwd, and the same
   * as `root` for every ordinary call. A walk started elsewhere (an absolute
   * pattern) still reports paths the model can hand straight back.
   */
  base?: string;
  pattern: string;
  /**
   * Match a nested file by its bare name as well. A pattern with no folder of
   * its own is a filename pattern (`*.ts` finds `src/a.ts`); a split walk keeps
   * that shape — `/repo/src/*.ts` must not start matching nested files by name
   * just because the walk now starts inside `src`. Absent = the pattern's own
   * shape, which is what a call that splits nothing gets.
   */
  nameOnly?: boolean;
  maxResults?: number;
}

export interface SearchRequest {
  root: string;
  /** Folder to walk, or one file, absolute and already checked against the cwd. */
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

export interface GlobFile {
  /** Relative and slash-separated, the way the model will hand it back. */
  path: string;
  /** `null` when the file vanished between the walk and the stat. */
  bytes: number | null;
}

export interface SearchFile {
  path: string;
  bytes: number;
  /** Lines in the file, counted the way {@link SearchHit.line} numbers them. */
  lines: number;
}

/** A file the scan could not look into, with the size that justifies the skip. */
export interface SkippedFile {
  path: string;
  bytes: number;
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

/** Wildcards the matcher understands; a `[` is a literal here, not a class. */
const GLOB_WILDCARD = /[*?]/;

/**
 * Split a glob into the folder it walks and the pattern inside it: `src/` with a
 * `*.ts` tail walks `src`, and an absolute pattern walks the folder it names.
 * Models write both forms, and the leading folders name where the search area
 * is — pinning every walk to the session cwd made an absolute pattern match
 * nothing at all.
 *
 * A wildcard-free pattern is left alone: `docs/README.md` names a path to match
 * in the workspace, not a folder to walk from (walking it would find nothing).
 */
export function splitGlobScope(raw: string): {
  dir: string;
  pattern: string;
  /** The model's own pattern carries no folder — see {@link GlobRequest.nameOnly}. */
  nameOnly: boolean;
} {
  const pattern = raw.trim().replace(/\\/g, "/");
  const nameOnly = !pattern.includes("/");
  const segments = pattern.split("/");
  const at = segments.findIndex((segment) => GLOB_WILDCARD.test(segment));
  if (at < 0) return { dir: "", pattern, nameOnly };
  const head = segments.slice(0, at).join("/");
  // `/x/*.ts` → `/x`: the leading empty segment is the filesystem root. A bare
  // drive needs its slash back, or "C:" would name the drive's current folder.
  const dir =
    head === "" && pattern.startsWith("/")
      ? "/"
      : /^[A-Za-z]:$/.test(head)
        ? `${head}/`
        : head;
  return { dir, pattern: segments.slice(at).join("/"), nameOnly };
}

/**
 * A path the model can use as it stands: relative while the file lives under
 * `base` (the session cwd), absolute once the walk left it. Either form goes
 * straight back into `read`.
 */
function shownPath(abs: string, base: string): string {
  const rel = path.relative(base, abs).split(path.sep).join("/");
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return abs.split(path.sep).join("/");
}

function matchesGlob(relPath: string, matcher: RegExp, nameOnly: boolean): boolean {
  if (matcher.test(relPath)) return true;
  // A pattern without a separator is a filename pattern: `*.ts` should find
  // `src/a.ts` too.
  return nameOnly && matcher.test(relPath.slice(relPath.lastIndexOf("/") + 1));
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

/** `null` when the file vanished between the walk and the stat. */
async function fileSize(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * Workspace files whose path matches `pattern`, relative and sorted. Each gets
 * its size: "is this the file I want" is a question the model asks on every
 * line, and it costs one stat per match — nothing next to the walk itself.
 */
export async function globFiles(
  req: GlobRequest,
): Promise<{ files: GlobFile[]; truncated: boolean }> {
  const limit = Math.max(1, Math.min(req.maxResults ?? MAX_GLOB_RESULTS, MAX_GLOB_RESULTS));
  const pattern = req.pattern.trim().replace(/\\/g, "/");
  if (!pattern) return { files: [], truncated: false };
  const matcher = globToRegExp(pattern);
  const base = req.base ?? req.root;
  const nameOnly = req.nameOnly ?? !pattern.includes("/");
  const files: GlobFile[] = [];
  let truncated = false;
  for await (const entry of walkFiles(req.root)) {
    if (!matchesGlob(entry.rel, matcher, nameOnly)) continue;
    if (files.length >= limit) {
      truncated = true;
      break;
    }
    files.push({ path: shownPath(entry.abs, base), bytes: await fileSize(entry.abs) });
  }
  files.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return { files, truncated };
}

/**
 * Matches of `pattern` (a JavaScript regex) across text files, line by line.
 * Every file that matched also reports its size and line count: the file was
 * just read whole, so both are free, and they are what tell the model whether
 * the hit it sees is worth opening the file for.
 */
export async function searchFiles(
  req: SearchRequest,
): Promise<{
  hits: SearchHit[];
  files: SearchFile[];
  truncated: boolean;
  filesScanned: number;
  /** Files the scan did not look into: too large to read, or binary. */
  skippedLarge: number;
  skippedLargeFiles: SkippedFile[];
  skippedBinary: number;
}> {
  const limit = Math.max(1, Math.min(req.maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
  const source = req.pattern.trim().slice(0, MAX_PATTERN_LENGTH);
  if (!source) {
    return {
      hits: [],
      files: [],
      truncated: false,
      filesScanned: 0,
      skippedLarge: 0,
      skippedLargeFiles: [],
      skippedBinary: 0,
    };
  }
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
  const files: SearchFile[] = [];
  let truncated = false;
  let filesScanned = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;
  const skippedLargeFiles: SkippedFile[] = [];
  // The scope is a folder, or one file the model named. A named file is searched
  // as it is: the size cap exists to protect a walk, not to refuse an explicit
  // target — and a folder cap that silently skipped it made grep answer "no
  // matches" for a file that was never opened.
  const named = req.dir ? await namedFile(req.dir, req.root) : undefined;
  const walk: WalkEntry[] | AsyncGenerator<WalkEntry> = named ? [named] : walkFiles(req.dir ?? req.root);
  const maxBytes = named ? NAMED_FILE_MAX_BYTES : MAX_FILE_BYTES;

  for await (const entry of walk) {
    if (!named && fileMatcher && !matchesGlob(entry.rel, fileMatcher, !fileGlob.includes("/"))) {
      continue;
    }
    filesScanned += 1;
    if (filesScanned > MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }
    const scan = await scanFile(entry.abs, maxBytes);
    if (scan === null) continue; // vanished mid-walk: nothing to report, nothing to read
    if (scan.kind === "skipped") {
      if (scan.reason === "binary") skippedBinary += 1;
      else {
        skippedLarge += 1;
        if (skippedLargeFiles.length < SKIPPED_FILES_LIST_CAP) {
          skippedLargeFiles.push({ path: entry.rel, bytes: scan.bytes });
        }
      }
      continue;
    }
    const lines = scan.lines;
    const matched: SearchHit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = matcher.exec(line);
      if (match === null) continue;
      if (hits.length + matched.length >= limit) {
        truncated = true;
        break;
      }
      matched.push({
        path: entry.rel,
        line: i + 1,
        // A window around the match: on a minified line the match sits far past
        // the first preview chars, and a head-cut would hide the one thing the
        // hit is for.
        text: matchContext(line, match.index),
      });
    }
    if (matched.length) {
      files.push({ path: entry.rel, bytes: scan.bytes, lines: lines.length });
      hits.push(...matched);
    }
    if (truncated) break;
  }
  // Walk order is filesystem order; a stable path/line order reads better in
  // the transcript and keeps the tool output reproducible.
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { hits, files, truncated, filesScanned, skippedLarge, skippedLargeFiles, skippedBinary };
}

/** What one candidate file turned out to be when the scan looked at it. */
type FileScan =
  | { kind: "text"; lines: string[]; bytes: number }
  | { kind: "skipped"; reason: "binary" | "large"; bytes: number };

/**
 * The file's lines (as hits number them) plus its size, or the reason there are
 * none. `null` when it vanished between the walk and the read: there is nothing
 * left to scan and nothing useful to report.
 */
async function scanFile(file: string, maxBytes: number): Promise<FileScan | null> {
  try {
    const stats = await fsp.stat(file);
    if (stats.size > maxBytes) return { kind: "skipped", reason: "large", bytes: stats.size };
    const buf = await fsp.readFile(file);
    if (buf.includes(0)) return { kind: "skipped", reason: "binary", bytes: stats.size };
    return { kind: "text", lines: buf.toString("utf8").split(/\r?\n/), bytes: stats.size };
  } catch {
    return null;
  }
}

/** The walk entry for `target` when it is a file rather than a folder to walk. */
async function namedFile(target: string, root: string): Promise<WalkEntry | undefined> {
  try {
    if (!(await fsp.stat(target)).isFile()) return undefined;
  } catch {
    return undefined; // a missing scope is reported by the tool as "no matches"
  }
  // Relative to the *walk root*, not to the file itself: a hit path is meant to
  // be handed straight back to read/grep.
  const rel = path.relative(root, target).split(path.sep).join("/");
  return { abs: target, rel: rel || path.basename(target) };
}

/** Text shown for a line: short lines whole, long ones as a window around the match. */
function matchContext(line: string, at: number): string {
  const shown = line.trim();
  if (shown.length <= MAX_LINE_PREVIEW) return shown;
  const half = Math.floor(MATCH_CONTEXT_CHARS / 2);
  let start = Math.max(0, at - half);
  let end = Math.min(line.length, start + MATCH_CONTEXT_CHARS);
  if (end - start < MATCH_CONTEXT_CHARS) start = Math.max(0, end - MATCH_CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}
