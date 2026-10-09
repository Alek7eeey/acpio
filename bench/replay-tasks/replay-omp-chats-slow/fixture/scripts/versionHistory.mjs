export const VERSIONS_HEADER = `# Release history

Patch version increases by 1 for each calendar day that has at least one git commit since the epoch (\`versionEpoch\` in \`package.json\`, default \`2026-08-26\`).

The number is taken from git history, so clones and local builds of the same revision show the same version. Local calendar days without commits do not bump it. \`npm run dev\` / \`npm run build\` refresh this table.

Release dates use \`DD.MM.YY\` (author date of that day's commits).

| Version | Released |
|---------|----------|
`;

export function formatReleaseDate(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = String(date.getFullYear()).slice(-2);
  return `${d}.${m}.${y}`;
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

export function upsertReleaseEntry(entries, version, released) {
  if (entries.some((entry) => entry.version === version)) return entries;
  return [{ version, released }, ...entries];
}

/** Default epoch for daily release numbering (versioning feature introduction). */
export const DEFAULT_VERSION_EPOCH = "2026-08-26";

export function parseLocalDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function uniqueCommitDays(commitDates, epochDate = DEFAULT_VERSION_EPOCH) {
  return [...new Set(commitDates.filter((date) => date && date >= epochDate))].sort();
}

/**
 * Patch = unique git author-days since epoch, minus one so the epoch day stays at base (0.1.0).
 * Same git history ⇒ same version on every machine.
 */
export function computeAppVersion({
  baseVersion,
  commitDates,
  epochDate = DEFAULT_VERSION_EPOCH,
}) {
  const days = uniqueCommitDays(commitDates, epochDate);
  const uniqueDays = days.length;
  const [major, minor, patch = "0"] = baseVersion.split(".");
  const bump = Math.max(0, uniqueDays - 1);
  const version = `${major}.${minor}.${parseInt(patch, 10) + bump}`;
  return { version, uniqueDays, epochDate, days };
}

/** Newest-first history rows derived from git commit days (for VERSIONS.md). */
export function releaseEntriesFromCommitDates({
  baseVersion,
  commitDates,
  epochDate = DEFAULT_VERSION_EPOCH,
}) {
  const days = uniqueCommitDays(commitDates, epochDate);
  const [major, minor, patch = "0"] = baseVersion.split(".");
  const basePatch = parseInt(patch, 10);
  return days
    .map((day, index) => ({
      version: `${major}.${minor}.${basePatch + index}`,
      released: formatReleaseDate(parseLocalDateKey(day)),
    }))
    .reverse();
}
