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
