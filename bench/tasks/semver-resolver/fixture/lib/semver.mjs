/**
 * Semver 2.0 subset for our internal registry: MAJOR.MINOR.PATCH with an
 * optional -PRERELEASE tag. Comparing follows the spec on the one point
 * that matters for releases: a prerelease binds LOWER than the version it
 * belongs to (1.0.0-rc.1 < 1.0.0). Prerelease tags compare
 * lexicographically — enough for our alpha/beta/rc tags.
 */
export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) throw new Error("bad version: " + version);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (A[key] !== B[key]) return A[key] - B[key];
  }
  if (A.prerelease === B.prerelease) return 0;
  if (A.prerelease === null) return -1;
  if (B.prerelease === null) return 1;
  return String(A.prerelease).localeCompare(String(B.prerelease));
}

/**
 * Ranges: "*" (releases only), "X.Y.Z" (exact), "^X.Y.Z" (same major, at
 * least X.Y.Z), "~X.Y.Z" (same major.minor, at least X.Y.Z), ">=X.Y.Z" and
 * "<=X.Y.Z". A prerelease satisfies a range only when the range itself
 * names a prerelease.
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (range === "*") return v.prerelease === null;
  if (v.prerelease !== null && !range.includes("-")) return false;
  if (range.startsWith("^")) {
    const base = range.slice(1);
    return v.major === parseVersion(base).major && compareVersions(version, base) >= 0;
  }
  if (range.startsWith("~")) {
    const base = range.slice(1);
    const b = parseVersion(base);
    return v.major === b.major && v.minor === b.minor && compareVersions(version, base) >= 0;
  }
  if (range.startsWith(">=")) return compareVersions(version, range.slice(2)) >= 0;
  if (range.startsWith("<=")) return compareVersions(version, range.slice(2)) <= 0;
  return compareVersions(version, range) === 0;
}
