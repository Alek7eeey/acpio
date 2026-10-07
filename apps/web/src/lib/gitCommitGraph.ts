import type { GitCommitDto } from "@acpio/shared";

export const GIT_LANE_COLORS = [
  "#2dd4bf",
  "#a78bfa",
  "#f472b6",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#60a5fa",
  "#c084fc",
  "#34d399",
] as const;

export function gitLaneColor(lane: number): string {
  return GIT_LANE_COLORS[((lane % GIT_LANE_COLORS.length) + GIT_LANE_COLORS.length) % GIT_LANE_COLORS.length]!;
}

export function normalizeCommitRefLabel(ref: string) {
  return ref.replace(/^origin\//, "");
}

/** Collapse local + origin refs that display the same (e.g. feature/x and origin/feature/x). */
export function dedupeCommitRefs(refs: string[], currentBranch?: string): string[] {
  const buckets = new Map<string, string[]>();
  for (const ref of refs) {
    const label = normalizeCommitRefLabel(ref);
    const list = buckets.get(label) ?? [];
    list.push(ref);
    buckets.set(label, list);
  }

  const rank = (ref: string) => {
    const short = normalizeCommitRefLabel(ref);
    if (currentBranch && (ref === currentBranch || short === currentBranch)) return 0;
    if (!ref.startsWith("origin/")) return 1;
    return 2;
  };

  return [...buckets.values()].map((list) =>
    [...list].sort((a, b) => rank(a) - rank(b))[0]!,
  );
}

/**
 * Line index for every row of the history list: each tip starts on line 0, its
 * first-parent chain keeps that line, and every further parent of a merge opens a
 * deeper one. The walk covers the commits the list has loaded — the graph is drawn
 * over exactly those, so scrolling older pages in extends the same picture instead
 * of restarting it.
 */
export function assignCommitDepths(commits: GitCommitDto[]): GitCommitDto[] {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const depth = new Map<string, number>();
  const seen = new Set<string>();

  const walk = (hash: string, line: number) => {
    if (seen.has(hash) || !byHash.has(hash)) return;
    seen.add(hash);
    depth.set(hash, Math.min(depth.get(hash) ?? line, line));
    const parents = byHash.get(hash)!.parents;
    parents.forEach((parent, index) => walk(parent, index === 0 ? line : line + 1));
  };

  // Tips: commits nothing else in the list points at (branch tips on the first
  // page, the oldest loaded commit once older pages are appended).
  const isParent = new Set<string>();
  for (const commit of commits) for (const parent of commit.parents) isParent.add(parent);
  for (const commit of commits) if (!isParent.has(commit.hash)) walk(commit.hash, 0);

  return commits.map((commit) => ({ ...commit, depth: depth.get(commit.hash) ?? 0 }));
}
