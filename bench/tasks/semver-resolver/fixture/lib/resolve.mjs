import { compareVersions, satisfiesRange } from "./semver.mjs";

/**
 * Pick the highest registry version that satisfies the range. Versions are
 * unique, so there are no ties. Throws when nothing satisfies — an empty
 * pick must never happen silently.
 */
export function resolveRange(range, versions) {
  const candidates = versions.filter((v) => satisfiesRange(v, range));
  if (candidates.length === 0) throw new Error("no version satisfies " + range);
  return candidates.sort(compareVersions)[candidates.length - 1];
}
