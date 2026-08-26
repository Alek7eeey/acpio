export const VERSIONS_HEADER = `# Release history

Release dates use \`DD.MM.YY\` (local date when the build ran).

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
