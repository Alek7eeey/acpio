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
