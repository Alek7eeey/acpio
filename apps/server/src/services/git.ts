import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { GitChangedFileDto, GitCommitDetailDto, GitCommitDto, GitCommitFileDto, GitStatusDto } from "@acpio/shared";

/**
 * Cap for path arrays on the git mutation routes. Untracked trees are reported
 * one row per file, so a folder like `piper/` alone exceeds a small cap.
 */
export const MAX_GIT_PATHS = 2000;

function runGit(
  cwd: string,
  args: string[],
  opts?: { network?: boolean },
): { ok: boolean; out: string; err: string } {
  const env = opts?.network
    ? {
        ...process.env,
        GCM_INTERACTIVE: "Always",
        GIT_TERMINAL_PROMPT: "1",
      }
    : process.env;
  const result = spawnSync("git", args, {
    cwd: path.resolve(cwd),
    encoding: "utf8",
    env,
    windowsHide: opts?.network ? process.platform !== "win32" : true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd(),
    err: (result.stderr ?? "").trim(),
  };
}

function gitFailureMessage(result: { out: string; err: string }) {
  return (result.err || result.out || "").trim();
}

function isNoUpstreamError(message: string) {
  const m = message.toLowerCase();
  return m.includes("no upstream") || m.includes("has no upstream branch") || m.includes("set the remote as upstream");
}

function isGitAuthError(message: string) {
  const m = message.toLowerCase();
  return (
    m.includes("authentication failed") ||
    m.includes("authorization failed") ||
    m.includes("could not read username") ||
    m.includes("could not read password") ||
    m.includes("invalid username or password") ||
    m.includes("terminal prompts disabled") ||
    m.includes("access denied") ||
    (m.includes("permission denied") && m.includes("http")) ||
    /\b401\b/.test(m) ||
    /\b403\b/.test(m)
  );
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function resolveGitRoot(cwd: string): string | null {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.out !== "true") return null;
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return null;
  return root.out.replace(/\\/g, "/");
}

/** Upstream to compare against: configured @{upstream}, else origin/<branch>. */
export function resolveGitUpstream(root: string, branch: string): string | null {
  const configured = runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (configured.ok && configured.out.trim()) return configured.out.trim();
  const name = branch.trim();
  if (!name) return null;
  const origin = runGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${name}`]);
  if (origin.ok) return `origin/${name}`;
  return null;
}

/** `git rev-list --left-right --count A...B` → "behind\\tahead". */
export function parseLeftRightCount(output: string): { behind: number; ahead: number } {
  const parts = output.trim().split(/\s+/);
  const behind = Number.parseInt(parts[0] ?? "0", 10);
  const ahead = Number.parseInt(parts[1] ?? "0", 10);
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

function gitAheadBehind(root: string, branch: string): { ahead: number; behind: number } {
  const upstream = resolveGitUpstream(root, branch);
  if (!upstream) return { ahead: 0, behind: 0 };
  const counts = runGit(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  if (!counts.ok) return { ahead: 0, behind: 0 };
  return parseLeftRightCount(counts.out);
}

function parsePrettyLog(output: string): GitCommitDto[] {
  const commits: GitCommitDto[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const hash = parts[0]!;
    const parents = parts[1]!.split(" ").filter(Boolean);
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      subject: parts[2] ?? "",
      author: parts[3] ?? "",
      date: parts[4] ?? "",
      depth: 0,
      merge: parents.length > 1,
      refs: [],
    });
  }
  return commits;
}

function getOutgoingCommits(root: string, branch: string, limit = 50): GitCommitDto[] {
  const upstream = resolveGitUpstream(root, branch);
  if (!upstream) return [];
  const raw = runGit(root, [
    "log",
    `${upstream}..HEAD`,
    `--max-count=${Math.min(Math.max(limit, 1), 100)}`,
    "--date=iso-strict",
    "--pretty=format:%H%x09%P%x09%s%x09%an%x09%ai",
  ]);
  if (!raw.ok || !raw.out) return [];
  return parsePrettyLog(raw.out);
}

function validateBranchName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("..") || /[\0\r\n]/.test(trimmed)) return "Invalid branch name";
  if (trimmed.startsWith("-") || trimmed.endsWith(".") || trimmed.endsWith("/")) return "Invalid branch name";
  if (/[\s~^:?*\\[\]]/.test(trimmed)) return "Invalid branch name";
  return null;
}

/** `git diff --shortstat` → line totals (untracked files are not included). */
export function parseShortstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  const insMatch = output.match(/(\d+)\s+insertion/);
  const delMatch = output.match(/(\d+)\s+deletion/);
  if (insMatch) additions = Number.parseInt(insMatch[1]!, 10) || 0;
  if (delMatch) deletions = Number.parseInt(delMatch[1]!, 10) || 0;
  return { additions, deletions };
}

const GIT_QUOTE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  n: "\n",
  t: "\t",
  r: "\r",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
};

/** Decode a git C-quoted path (`"a b"`, `\320\277`) back into the real file name. */
export function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const chunks: Buffer[] = [];
  let text = "";
  const flush = () => {
    if (text) chunks.push(Buffer.from(text, "utf8"));
    text = "";
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      text += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) {
      text += "\\";
      break;
    }
    const simple = GIT_QUOTE_ESCAPES[next];
    if (simple !== undefined) {
      text += simple;
      continue;
    }
    // Octal escapes are raw UTF-8 bytes, so they cannot be appended per byte.
    const octal = /^[0-7]{1,3}/.exec(body.slice(i, i + 3))?.[0];
    if (octal) {
      flush();
      chunks.push(Buffer.from([Number.parseInt(octal, 8)]));
      i += octal.length - 1;
      continue;
    }
    text += next;
  }
  flush();
  return Buffer.concat(chunks).toString("utf8");
}

/** `git diff --numstat` path column; renames keep only the new name. */
function parseNumstatPath(raw: string) {
  const renamed = raw.includes(" => ") ? raw.split(" => ").pop()! : raw;
  return unquoteGitPath(renamed);
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : parseInt(parts[0]!, 10) || 0;
    const deletions = parts[1] === "-" ? 0 : parseInt(parts[1]!, 10) || 0;
    map.set(parseNumstatPath(parts.slice(2).join("\t")), { additions, deletions });
  }
  return map;
}

function mergeNumstat(
  target: Map<string, { additions: number; deletions: number }>,
  source: Map<string, { additions: number; deletions: number }>,
) {
  for (const [filePath, stats] of source) {
    const prev = target.get(filePath);
    target.set(filePath, {
      additions: (prev?.additions ?? 0) + stats.additions,
      deletions: (prev?.deletions ?? 0) + stats.deletions,
    });
  }
}

function isConflictFile(f: { index: string; worktree: string }) {
  return (
    f.index === "U" ||
    f.worktree === "U" ||
    (f.index === "A" && f.worktree === "A") ||
    (f.index === "D" && f.worktree === "D")
  );
}

function parsePorcelain(output: string, numstat: Map<string, { additions: number; deletions: number }>) {
  const files: GitChangedFileDto[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^(.)(.)\s+(.*)$/);
    if (!match) continue;
    const index = match[1] ?? " ";
    const worktree = match[2] ?? " ";
    const rawPath = match[3]!.trim();
    // Renames arrive as `old -> new`; git quotes each side separately.
    const filePath = unquoteGitPath((rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath).trim());
    const stats = numstat.get(filePath) ?? { additions: 0, deletions: 0 };
    const untracked = index === "?" && worktree === "?";
    const staged = !untracked && index !== " ";
    const unstaged = untracked || (worktree !== " " && worktree !== "?");
    files.push({
      path: filePath,
      index,
      worktree,
      staged,
      unstaged,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }
  return files;
}

function trackedLineTotals(root: string): { additions: number; deletions: number } {
  const staged = parseShortstat(runGit(root, ["diff", "--cached", "--shortstat"]).out);
  const unstaged = parseShortstat(runGit(root, ["diff", "--shortstat"]).out);
  return {
    additions: staged.additions + unstaged.additions,
    deletions: staged.deletions + unstaged.deletions,
  };
}

function buildStatusSummary(root: string): GitStatusDto {
  const branch = runGit(root, ["branch", "--show-current"]);
  const porcelain = runGit(root, ["status", "--porcelain=v1", "-uall"]);
  const files = parsePorcelain(porcelain.out, new Map());
  const conflict = files.some(isConflictFile);
  const stagedCount = files.filter((f) => f.staged).length;
  const unstagedCount = files.filter((f) => f.unstaged).length;
  const { additions, deletions } = trackedLineTotals(root);
  const { ahead, behind } = gitAheadBehind(root, branch.ok ? branch.out : "");

  return {
    repo: true,
    root,
    branch: branch.ok ? branch.out : "",
    dirty: files.length > 0,
    conflict,
    branches: [],
    files,
    stagedCount,
    unstagedCount,
    additions,
    deletions,
    stashCount: 0,
    aheadCount: ahead,
    behindCount: behind,
  };
}

function buildStatus(root: string): GitStatusDto {
  const branch = runGit(root, ["branch", "--show-current"]);
  const branches = runGit(root, ["branch", "--format=%(refname:short)"]);
  const porcelain = runGit(root, ["status", "--porcelain=v1", "-uall"]);

  const numstat = new Map<string, { additions: number; deletions: number }>();
  mergeNumstat(numstat, parseNumstat(runGit(root, ["diff", "--cached", "--numstat"]).out));
  mergeNumstat(numstat, parseNumstat(runGit(root, ["diff", "--numstat"]).out));

  const files = parsePorcelain(porcelain.out, numstat);
  const conflict = files.some(isConflictFile);
  const stagedCount = files.filter((f) => f.staged).length;
  const unstagedCount = files.filter((f) => f.unstaged).length;
  const { additions, deletions } = trackedLineTotals(root);
  const stashList = runGit(root, ["stash", "list"]);
  const stashCount = stashList.ok ? stashList.out.split("\n").filter(Boolean).length : 0;
  const { ahead, behind } = gitAheadBehind(root, branch.ok ? branch.out : "");

  return {
    repo: true,
    root,
    branch: branch.ok ? branch.out : "",
    dirty: files.length > 0,
    conflict,
    branches: [...new Set(branches.ok ? branches.out.split("\n").filter(Boolean) : [])].sort((a, b) =>
      a.localeCompare(b),
    ),
    files,
    stagedCount,
    unstagedCount,
    additions,
    deletions,
    stashCount,
    aheadCount: ahead,
    behindCount: behind,
  };
}

export function getGitStatus(cwd: string, opts?: { summary?: boolean }): GitStatusDto {
  const empty: GitStatusDto = {
    repo: false,
    root: "",
    branch: "",
    dirty: false,
    conflict: false,
    branches: [],
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    additions: 0,
    deletions: 0,
    stashCount: 0,
    aheadCount: 0,
    behindCount: 0,
  };
  const root = resolveGitRoot(cwd);
  if (!root) return empty;
  return opts?.summary ? buildStatusSummary(root) : buildStatus(root);
}

function nullDevice() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export function getGitDiff(cwd: string, filePath?: string): string {
  const root = resolveGitRoot(cwd);
  if (!root) return "";

  if (filePath?.trim()) {
    const rel = filePath.trim();
    const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", rel]);
    if (tracked.ok) {
      return runGit(root, ["diff", "--no-color", "HEAD", "--", rel]).out;
    }
    return runGit(root, ["diff", "--no-color", "--no-index", nullDevice(), rel]).out;
  }

  const chunks: string[] = [];
  const head = runGit(root, ["diff", "--no-color", "HEAD"]);
  if (head.out) chunks.push(head.out);
  for (const rel of runGit(root, ["ls-files", "--others", "--exclude-standard"]).out.split("\n").filter(Boolean)) {
    const diff = runGit(root, ["diff", "--no-color", "--no-index", nullDevice(), rel]);
    if (diff.out) chunks.push(diff.out);
  }
  return chunks.join("\n\n");
}

export function checkoutGitBranch(
  cwd: string,
  branch: string,
  opts?: { create?: boolean },
): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateBranchName(branch);
  if (invalid) return { ok: false, error: invalid };
  const args = opts?.create ? ["checkout", "-b", branch.trim()] : ["checkout", branch.trim()];
  const result = runGit(root, args);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Checkout failed" };
}

export function checkoutGitRevision(cwd: string, rev: string): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const name = validateRevision(rev);
  if (!name) return { ok: false, error: "Invalid revision" };
  const result = runGit(root, ["checkout", "--detach", name]);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Checkout failed" };
}

function validateGitPaths(paths: string[]): string | null {
  if (paths.length === 0) return "No paths selected";
  for (const p of paths) {
    if (!p.trim() || p.includes("..") || /[\0\r\n]/.test(p)) return "Invalid path";
  }
  return null;
}

/** Repo-relative paths: normalized (forward slashes, no trailing slash), deduped. */
function normalizeGitPaths(paths: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const rel = p
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    result.push(rel);
  }
  return result;
}

/**
 * Split requested paths by what git can act on. A folder matches itself and
 * everything below it, so folder-level actions hand git the folder path instead
 * of enumerating files — the panel lists a large untracked tree one row per file.
 */
function classifyGitPaths(root: string, requested: string[]) {
  const entries = parsePorcelain(runGit(root, ["status", "--porcelain=v1", "-uall"]).out, new Map()).map(
    (file) => ({ path: file.path, untracked: file.index === "?" && file.worktree === "?" }),
  );
  const covers = (rel: string, entry: { path: string }) => entry.path === rel || entry.path.startsWith(`${rel}/`);
  return {
    changed: requested.filter((rel) => entries.some((entry) => !entry.untracked && covers(rel, entry))),
    untracked: requested.filter((rel) => entries.some((entry) => entry.untracked && covers(rel, entry))),
  };
}

export function setGitStage(cwd: string, paths: string[], staged: boolean): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateGitPaths(paths);
  if (invalid) return { ok: false, error: invalid };
  const args = staged ? ["add", "--", ...paths] : ["reset", "HEAD", "--", ...paths];
  const result = runGit(root, args);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Stage failed" };
}

export function discardGitChanges(cwd: string, paths: string[]): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateGitPaths(paths);
  if (invalid) return { ok: false, error: invalid };

  const requested = normalizeGitPaths(paths);
  const { changed, untracked } = classifyGitPaths(root, requested);

  if (changed.length > 0) {
    const result = runGit(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...changed]);
    if (!result.ok) return { ok: false, error: result.err || result.out || "Discard failed" };
  }
  if (untracked.length > 0) {
    // `-d` lets clean take a folder (and prune the directories it empties).
    const result = runGit(root, ["clean", "-f", "-d", "--", ...untracked]);
    if (!result.ok) return { ok: false, error: result.err || result.out || "Discard failed" };
  }
  return { ok: true };
}

export function deleteGitFiles(cwd: string, paths: string[]): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateGitPaths(paths);
  if (invalid) return { ok: false, error: invalid };

  const requested = normalizeGitPaths(paths);
  // `git rm -r` drops every tracked file under the path; untracked leftovers and
  // the directories it emptied go through clean.
  const tracked = requested.filter((rel) => runGit(root, ["ls-files", "--error-unmatch", "--", rel]).ok);
  if (tracked.length > 0) {
    const result = runGit(root, ["rm", "-f", "-r", "--", ...tracked]);
    if (!result.ok) return { ok: false, error: result.err || result.out || "Delete failed" };
  }
  const cleanResult = runGit(root, ["clean", "-f", "-d", "--", ...requested]);
  if (!cleanResult.ok) return { ok: false, error: cleanResult.err || cleanResult.out || "Delete failed" };
  return { ok: true };
}

/** `.gitignore` line for a repo-relative path; the leading `/` anchors it to the repo root. */
export function toGitIgnorePattern(relPath: string, isDir: boolean): string {
  const rel = relPath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!rel) return "";
  const pattern = `/${rel}${isDir ? "/" : ""}`;
  // Git drops trailing spaces unless they are escaped.
  return pattern.replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length));
}

/** Append patterns to `.gitignore` text, keeping its line endings and skipping duplicates. */
export function appendGitIgnoreEntries(
  existing: string,
  patterns: string[],
): { content: string; added: string[] } {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const known = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const added: string[] = [];
  for (const pattern of patterns) {
    if (!pattern || known.has(pattern)) continue;
    known.add(pattern);
    added.push(pattern);
  }
  if (added.length === 0) return { content: existing, added };
  const base = existing === "" || existing.endsWith("\n") ? existing : `${existing}${eol}`;
  return { content: `${base}${added.join(eol)}${eol}`, added };
}

/** Add repo-relative paths (files or directories) to the repository's root `.gitignore`. */
export function addGitIgnoreEntries(
  cwd: string,
  paths: string[],
): { ok: boolean; error?: string; added: string[] } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository", added: [] };
  const invalid = validateGitPaths(paths);
  if (invalid) return { ok: false, error: invalid, added: [] };

  const rootAbs = path.resolve(root);
  const patterns: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(rootAbs, p);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      return { ok: false, error: "Invalid path", added: [] };
    }
    const isDir = fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory() ?? false;
    patterns.push(toGitIgnorePattern(p, isDir));
  }

  const file = path.join(rootAbs, ".gitignore");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* no .gitignore yet — it will be created */
  }
  const { content, added } = appendGitIgnoreEntries(existing, patterns);
  if (added.length === 0) return { ok: true, added };
  try {
    fs.writeFileSync(file, content, "utf8");
  } catch {
    return { ok: false, error: "Could not update .gitignore", added: [] };
  }
  return { ok: true, added };
}

export function getGitBlame(cwd: string, filePath: string): string {
  const root = resolveGitRoot(cwd);
  if (!root) return "";
  const rel = filePath.trim().replace(/\\/g, "/");
  if (!rel || rel.includes("..") || /[\0\r\n]/.test(rel)) return "";

  const tracked = runGit(root, ["ls-files", "--error-unmatch", "--", rel]);
  if (!tracked.ok) return "";

  const exists = fs.existsSync(path.join(root, rel));
  const args = exists
    ? ["blame", "--date=short", "--", rel]
    : ["blame", "--date=short", "HEAD", "--", rel];
  const result = runGit(root, args);
  return result.ok ? result.out : result.err || "";
}

function readWorktreeLines(root: string, rel: string): string[] | null {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    const content = fs.readFileSync(abs, "utf8");
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  } catch {
    return null;
  }
}

function readRefLines(root: string, rel: string, ref: string): string[] | null {
  const result = runGit(root, ["show", `${ref}:${rel}`]);
  if (!result.ok) return null;
  if (!result.out) return [];
  return result.out.split("\n");
}

export function getGitFileLines(
  cwd: string,
  filePath: string,
  startLine: number,
  endLine: number,
  side: "old" | "new",
  source: { mode: "working" } | { mode: "commit"; rev: string },
): { lines: string[]; startLine: number; endLine: number; totalLines: number } | null {
  const root = resolveGitRoot(cwd);
  if (!root) return null;
  const rel = filePath.trim().replace(/\\/g, "/");
  if (!rel || rel.includes("..") || /[\0\r\n]/.test(rel)) return null;

  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.floor(endLine));

  let allLines: string[] | null = null;
  if (source.mode === "working") {
    allLines = side === "new" ? readWorktreeLines(root, rel) : readRefLines(root, rel, "HEAD");
  } else {
    const rev = source.rev.trim();
    if (!rev || rev.includes("..") || /[\0\r\n]/.test(rev)) return null;
    if (side === "new") allLines = readRefLines(root, rel, rev);
    else {
      const parent = runGit(root, ["rev-parse", `${rev}^`]);
      if (!parent.ok || !parent.out) return { lines: [], startLine: start, endLine: start - 1, totalLines: 0 };
      allLines = readRefLines(root, rel, parent.out);
    }
  }

  if (!allLines) return null;
  const totalLines = allLines.length;
  return {
    lines: allLines.slice(start - 1, Math.min(end, totalLines)),
    startLine: start,
    endLine: Math.min(end, totalLines),
    totalLines,
  };
}

export function commitGit(cwd: string, message: string): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "Commit message required" };
  const result = runGit(root, ["commit", "-m", trimmed]);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Commit failed" };
}

export async function syncGit(
  cwd: string,
  action: "fetch" | "pull" | "push",
): Promise<{ ok: boolean; conflict?: boolean; output?: string; error?: string }> {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const args = action === "fetch" ? ["fetch"] : action === "pull" ? ["pull", "--no-rebase"] : ["push"];
  let result = runGit(root, args, { network: true });
  if (!result.ok && isGitAuthError(gitFailureMessage(result))) {
    await sleepMs(2000);
    result = runGit(root, args, { network: true });
  }
  if (
    !result.ok &&
    action === "push" &&
    isNoUpstreamError(gitFailureMessage(result)) &&
    runGit(root, ["remote", "get-url", "origin"]).ok
  ) {
    result = runGit(root, ["push", "-u", "origin", "HEAD"], { network: true });
  }
  if (result.ok) {
    return { ok: true, output: result.out || result.err };
  }
  const message = gitFailureMessage(result) || `${action} failed`;
  if (action === "pull" && buildStatus(root).conflict) {
    return { ok: false, conflict: true, output: message, error: message };
  }
  return { ok: false, error: message };
}

export function stashGit(
  cwd: string,
  action: "push" | "pop",
  message?: string,
): { ok: boolean; output?: string; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  if (action === "pop") {
    const result = runGit(root, ["stash", "pop"]);
    return result.ok
      ? { ok: true, output: result.out || result.err }
      : { ok: false, error: result.err || result.out || "Stash pop failed" };
  }
  const trimmed = message?.trim();
  const args = trimmed ? ["stash", "push", "-m", trimmed] : ["stash", "push", "-m", "WIP"];
  const result = runGit(root, args);
  return result.ok
    ? { ok: true, output: result.out || result.err }
    : { ok: false, error: result.err || result.out || "Stash failed" };
}

function validateRevision(rev: string): string | null {
  const name = rev.trim();
  if (!name || name.includes("..") || /[\0\r\n]/.test(name)) return null;
  return name;
}

export function applyGitCommitAction(
  cwd: string,
  action: "revert" | "cherry-pick",
  rev: string,
): { ok: boolean; output?: string; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const name = validateRevision(rev);
  if (!name) return { ok: false, error: "Invalid revision" };
  const args = action === "revert" ? ["revert", "--no-edit", name] : ["cherry-pick", name];
  const result = runGit(root, args);
  return result.ok
    ? { ok: true, output: result.out || result.err }
    : { ok: false, error: result.err || result.out || `${action} failed` };
}

function validateTagName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("..") || /[\0\r\n]/.test(trimmed)) return "Invalid tag name";
  if (trimmed.startsWith("-") || trimmed.endsWith(".") || trimmed.endsWith("/")) return "Invalid tag name";
  if (/[\s~^:?*\\[\]]/.test(trimmed)) return "Invalid tag name";
  if (trimmed.endsWith(".lock")) return "Invalid tag name";
  return null;
}

export function createGitBranchAt(
  cwd: string,
  branch: string,
  rev: string,
): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateBranchName(branch);
  if (invalid) return { ok: false, error: invalid };
  const name = validateRevision(rev);
  if (!name) return { ok: false, error: "Invalid revision" };
  const result = runGit(root, ["branch", branch.trim(), name]);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Create branch failed" };
}

export function createGitTagAt(
  cwd: string,
  tag: string,
  rev: string,
): { ok: boolean; error?: string } {
  const root = resolveGitRoot(cwd);
  if (!root) return { ok: false, error: "Not a git repository" };
  const invalid = validateTagName(tag);
  if (invalid) return { ok: false, error: invalid };
  const name = validateRevision(rev);
  if (!name) return { ok: false, error: "Invalid revision" };
  const result = runGit(root, ["tag", tag.trim(), name]);
  return result.ok ? { ok: true } : { ok: false, error: result.err || result.out || "Create tag failed" };
}

function dedupeCommitRefs(refs: string[]): string[] {
  const buckets = new Map<string, string[]>();
  for (const ref of refs) {
    const label = ref.replace(/^origin\//, "");
    const list = buckets.get(label) ?? [];
    list.push(ref);
    buckets.set(label, list);
  }
  return [...buckets.values()].map((list) => {
    const local = list.find((ref) => !ref.startsWith("origin/"));
    return local ?? list[0]!;
  });
}

export function getGitLog(cwd: string, limit = 60): { commits: GitCommitDto[]; outgoing: GitCommitDto[] } {
  const root = resolveGitRoot(cwd);
  if (!root) return { commits: [], outgoing: [] };

  const head = runGit(root, ["rev-parse", "HEAD"]);
  if (!head.ok) return { commits: [], outgoing: [] };
  const branch = runGit(root, ["branch", "--show-current"]);
  const outgoing = getOutgoingCommits(root, branch.ok ? branch.out : "");

  const refsByHash = new Map<string, string[]>();
  const refsRaw = runGit(root, [
    "for-each-ref",
    "--format=%(objectname)\t%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (refsRaw.out) {
    for (const line of refsRaw.out.split("\n")) {
      if (!line.trim()) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const hash = line.slice(0, tab);
      const ref = line.slice(tab + 1).trim();
      if (!hash || !ref) continue;
      const list = refsByHash.get(hash) ?? [];
      list.push(ref);
      refsByHash.set(hash, list);
    }
  }

  const raw = runGit(root, [
    "log",
    `--max-count=${Math.min(Math.max(limit, 1), 200)}`,
    "--date=iso-strict",
    "--pretty=format:%H%x09%P%x09%s%x09%an%x09%ai",
  ]);
  if (!raw.out) return { commits: [], outgoing };

  type Node = {
    hash: string;
    shortHash: string;
    parents: string[];
    subject: string;
    author: string;
    date: string;
    merge: boolean;
  };

  const nodes = new Map<string, Node>();
  const order: string[] = [];

  for (const line of raw.out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const hash = parts[0]!;
    const parents = parts[1]!.split(" ").filter(Boolean);
    nodes.set(hash, {
      hash,
      shortHash: hash.slice(0, 7),
      parents,
      subject: parts[2] ?? "",
      author: parts[3] ?? "",
      date: parts[4] ?? "",
      merge: parents.length > 1,
    });
    order.push(hash);
  }

  const depthByHash = new Map<string, number>();
  const seen = new Set<string>();

  function walk(hash: string, depth: number) {
    if (seen.has(hash) || !nodes.has(hash)) return;
    seen.add(hash);
    depthByHash.set(hash, Math.min(depthByHash.get(hash) ?? depth, depth));
    const node = nodes.get(hash)!;
    node.parents.forEach((parent, index) => {
      walk(parent, index === 0 ? depth : depth + 1);
    });
  }

  walk(head.out, 0);

  const commits = order
    .filter((hash) => nodes.has(hash))
    .map((hash) => {
      const node = nodes.get(hash)!;
      return {
        hash: node.hash,
        shortHash: node.shortHash,
        parents: node.parents,
        subject: node.subject,
        author: node.author,
        date: node.date,
        depth: depthByHash.get(hash) ?? 0,
        merge: node.merge,
        refs: dedupeCommitRefs(refsByHash.get(hash) ?? []),
      };
    });

  return { commits, outgoing };
}

export function getGitShow(cwd: string, rev: string, filePath?: string): string {
  const root = resolveGitRoot(cwd);
  if (!root) return "";
  const name = rev.trim();
  if (!name || name.includes("..") || /[\0\r\n]/.test(name)) return "";
  const path = filePath?.trim().replace(/\\/g, "/");
  if (path && (path.includes("..") || /[\0\r\n]/.test(path))) return "";
  const args = path
    ? ["show", "--no-color", name, "--", path]
    : ["show", "--no-color", "--format=fuller", name];
  const result = runGit(root, args);
  return result.out || result.err;
}

function mapCommitFileStatus(code: string): GitCommitFileDto["status"] {
  switch (code.charAt(0)) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typeChanged";
    default:
      return "other";
  }
}

export function getGitCommitDetail(cwd: string, rev: string): GitCommitDetailDto | null {
  const root = resolveGitRoot(cwd);
  if (!root) return null;
  const name = rev.trim();
  if (!name || name.includes("..") || /[\0\r\n]/.test(name)) return null;

  const header = runGit(root, [
    "show",
    "-s",
    "--format=%H%x09%P%x09%s%x09%an%x09%ae%x09%ai",
    name,
  ]);
  if (!header.ok || !header.out) return null;
  const parts = header.out.split("\t");
  if (parts.length < 6) return null;

  const hash = parts[0]!;
  const parents = parts[1]!.split(" ").filter(Boolean);
  const subject = parts[2] ?? "";
  const author = parts[3] ?? "";
  const authorEmail = parts[4] ?? "";
  const date = parts[5] ?? "";
  const bodyOut = runGit(root, ["show", "-s", "--format=%b", name]);
  const body = bodyOut.out ?? "";

  const numstatMap = parseNumstat(runGit(root, ["show", "--numstat", "--format=", name]).out);
  const statusRaw = runGit(root, ["show", "--name-status", "--format=", "-M", name]);

  const files: GitCommitFileDto[] = [];
  let additions = 0;
  let deletions = 0;
  let modifiedCount = 0;
  let addedCount = 0;
  let deletedCount = 0;

  for (const line of statusRaw.out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const code = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    const status = mapCommitFileStatus(code);

    let path = rest.trim();
    let oldPath: string | undefined;
    if (status === "renamed" || status === "copied") {
      const renameParts = rest.split("\t");
      if (renameParts.length >= 2) {
        oldPath = renameParts[0]!.trim();
        path = renameParts[1]!.trim();
      }
    }

    const stats =
      numstatMap.get(path) ??
      (oldPath ? numstatMap.get(oldPath) : undefined) ??
      { additions: 0, deletions: 0 };
    additions += stats.additions;
    deletions += stats.deletions;

    if (status === "added") addedCount += 1;
    else if (status === "deleted") deletedCount += 1;
    else if (status === "modified" || status === "renamed" || status === "typeChanged") modifiedCount += 1;
    else if (status === "copied") addedCount += 1;

    files.push({
      path,
      oldPath,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));

  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    body: body.trim(),
    author,
    authorEmail,
    date,
    parents,
    parentShortHashes: parents.map((parent) => parent.slice(0, 7)),
    files,
    additions,
    deletions,
    modifiedCount,
    addedCount,
    deletedCount,
  };
}
