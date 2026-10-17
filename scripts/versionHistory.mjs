/**
 * The version rule, as pure functions: no git, no filesystem (git is
 * scripts/releaseTags.mjs, the stamping is scripts/generate-version.mjs).
 *
 * A release is a `v<major>.<minor>.<patch>` git tag. The version a revision is
 * released as is therefore:
 *
 *   - its own tag, when the revision is tagged (a release commit reports the
 *     number it was published under), else
 *   - one patch above the highest release tag reachable from it, else
 *   - the base version, when nothing has been released yet.
 *
 * Tags are part of git, so every machine derives the same number offline, and the
 * release cadence is the maintainer's: a week of commits is still one bump, and
 * the numbers follow in order because they follow the releases.
 */
export const VERSIONS_HEADER = `# Release history

One row per release, newest first. A release is a \`v<major>.<minor>.<patch>\` git
tag — the release run pushes it (\`.github/workflows/release.yml\`) and npm holds
these same numbers, so this table lists the versions that were actually published
instead of every commit day.

The next release is one patch above the highest tag reachable from the revision;
a tagged revision reports its own tag (\`scripts/releaseTags.mjs\`). Tags live in
git, so the number needs no network and reads the same on every machine.

Release dates use \`DD.MM.YY\` (author date of the tagged commit).

| Version | Released |
|---------|----------|
`;

/** Files the version stamp rewrites; all of them travel inside the commit that bumps. */
export const VERSION_STAMP = {
  readme: "README.md",
  readmeRu: "readme-ru.md",
  versions: "VERSIONS.md",
  buildInfo: "packages/shared/src/buildInfo.ts",
};
export const VERSION_STAMP_FILES = Object.values(VERSION_STAMP);

/** Released versions only: a tag carrying a prerelease or build part is not one. */
const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** `v0.1.38` (or `0.1.38`) → `0.1.38`; anything else (rc, build metadata) → null. */
export function parseReleaseVersion(tag) {
  const match = RELEASE_TAG.exec(tag ?? "");
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** Numeric, part by part — string ordering would put 0.1.9 above 0.1.10. */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** Highest of the given released versions, or null for none. */
export function latestVersion(versions) {
  return versions.length === 0 ? null : versions.slice().sort(compareVersions).at(-1);
}

/** `0.1.38` → `0.1.39`; major and minor move only when a tag says so. */
export function bumpPatch(version) {
  const [major, minor, patch] = parseReleaseVersion(version).split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** The version this revision releases as — see the rule at the top of this file. */
export function nextVersion({ baseVersion, releases = [] }) {
  const latest = latestVersion(releases);
  return latest === null ? baseVersion : bumpPatch(latest);
}

/** Author day `2026-08-26` (git's `%as`) as the table's `26.08.26`. */
export function formatReleaseDay(day) {
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year.slice(-2)}`;
}

export function parseVersionsMarkdown(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    const match = /^\|\s*(\d+\.\d+\.\d+)\s*\|\s*(\d{2}\.\d{2}\.\d{2})\s*\|/.exec(line);
    if (match) entries.push({ version: match[1], released: match[2] });
  }
  return entries;
}

export function renderVersionsMarkdown(entries) {
  if (entries.length === 0) return `${VERSIONS_HEADER}\n`;
  const rows = entries.map((entry) => `| ${entry.version} | ${entry.released} |`).join("\n");
  return `${VERSIONS_HEADER}${rows}\n`;
}
