import type { GitChangedFileDto } from "@acpio/shared";

export function normalizeGitPath(path: string) {
  return path.replace(/\\/g, "/");
}

/** Join git repo root with a repo-relative path. */
export function joinRepoPath(root: string, rel: string) {
  const normalizedRoot = normalizeGitPath(root).replace(/\/+$/, "");
  const normalizedRel = normalizeGitPath(rel).replace(/^\/+/, "");
  return `${normalizedRoot}/${normalizedRel}`;
}

/** Absolute on-disk path for clipboard / OS handlers. */
export function toRepoAbsolutePath(root: string, rel: string) {
  const joined = joinRepoPath(root, rel);
  const useBackslash = /^[A-Za-z]:/.test(joined);
  if (!useBackslash) return joined;
  return joined.replace(/\//g, "\\");
}

export function sortGitFiles(files: GitChangedFileDto[]): GitChangedFileDto[] {
  return [...files].sort((a, b) =>
    normalizeGitPath(a.path).localeCompare(normalizeGitPath(b.path), undefined, { sensitivity: "base" }),
  );
}

/** First file in the same order as the changes tree (conflicts → unstaged → staged). */
export function firstChangedFilePath(input: {
  conflictFiles?: GitChangedFileDto[];
  unstagedFiles?: GitChangedFileDto[];
  stagedFiles?: GitChangedFileDto[];
  files?: GitChangedFileDto[];
}): string | null {
  for (const list of [input.conflictFiles, input.unstagedFiles, input.stagedFiles, input.files]) {
    if (!list?.length) continue;
    const first = sortGitFiles(list)[0];
    if (first) return first.path;
  }
  return null;
}

/** One flattened row of the changed-file tree (dirs first, then files, by name). */
export type GitFileTreeRow =
  | { kind: "dir"; key: string; path: string; name: string; depth: number }
  | { kind: "file"; key: string; index: number; path: string; name: string; depth: number };

type TreeDirNode = {
  name: string;
  path: string;
  dirs: Map<string, TreeDirNode>;
  files: { name: string; index: number; path: string }[];
};

function treeNameCompare(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Flatten changed files into tree rows. `files` keeps the caller's order, which
 * is the index used for navigation; `collapsed` holds full dir paths that are
 * folded away.
 */
export function buildGitFileTreeRows(
  files: { path: string }[],
  collapsed: ReadonlySet<string> = new Set(),
): GitFileTreeRow[] {
  const root: TreeDirNode = { name: "", path: "", dirs: new Map(), files: [] };

  files.forEach((file, index) => {
    const path = normalizeGitPath(file.path);
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop() ?? path;
    let node = root;
    for (const part of parts) {
      const dirPath = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: dirPath, dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ name: name || path, index, path });
  });

  const rows: GitFileTreeRow[] = [];
  const walk = (node: TreeDirNode, depth: number) => {
    for (const dir of [...node.dirs.values()].sort(treeNameCompare)) {
      rows.push({ kind: "dir", key: `d:${dir.path}`, path: dir.path, name: dir.name, depth });
      if (collapsed.has(dir.path)) continue;
      walk(dir, depth + 1);
    }
    for (const file of [...node.files].sort(treeNameCompare)) {
      rows.push({
        kind: "file",
        key: `f:${file.index}`,
        index: file.index,
        path: file.path,
        name: file.name,
        depth,
      });
    }
  };
  walk(root, 0);
  return rows;
}

export function firstCommitFilePath(files: { path: string }[]): string | null {
  if (files.length === 0) return null;
  return [...files]
    .sort((a, b) =>
      normalizeGitPath(a.path).localeCompare(normalizeGitPath(b.path), undefined, { sensitivity: "base" }),
    )[0]!.path;
}
