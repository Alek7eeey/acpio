/**
 * Is there a newer Acpio to download?
 *
 * The number the app reports is `BUILD_INFO.released` — the release tag this
 * build came from — and the number it is compared with is whatever npm's
 * `latest` dist-tag names. Both sides are plain `major.minor.patch` strings
 * (a prerelease only ever goes out under another dist-tag), so the comparison
 * is the semver one, written here because the web bundle must not pull a
 * package in just to order three numbers.
 */

/** What the header's popup has to draw: the two numbers and how far an install got. */
export interface AppUpdateStateDto {
  /** The release this build came from. */
  current: string;
  /** What npm calls latest; null when the registry could not be read. */
  latest: string | null;
  available: boolean;
  status: AppUpdateStatus;
  /** The installer's last words — shown when it failed. */
  message?: string;
  /** When the registry answer behind `latest` was fetched (ISO), null if never. */
  checkedAt: string | null;
}

/** `idle` → `installing` → `done` | `error`; done means "restart to use it". */
export type AppUpdateStatus = "idle" | "installing" | "done" | "error";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, empty for a release. */
  pre: string[];
}

/** `1.2.3`, `v1.2.3`, `1.2.3-rc.1` — the shapes a dist-tag can name. */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]*)?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION_RE.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence of two prerelease lists (npm's own rules, §11). */
function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  // A release outranks any prerelease of the same number.
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * -1 / 0 / 1, the way `a` orders against `b`. A string that is not a version
 * orders equal to everything: a garbled registry answer must not read as an
 * update, and the caller has only one decision to make from it.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/** True when `latest` is a version this build is not: the popup's question. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
