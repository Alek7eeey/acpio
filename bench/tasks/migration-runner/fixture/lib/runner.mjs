/**
 * Migration runner. Contract:
 * - migrations apply in strict NUMERIC id order (not lexicographic —
 *   "10" sorts before "2" as a string);
 * - an already-applied migration whose source changed since must abort
 *   with Error (checksum mismatch) — editing applied migrations is a
 *   freeze violation;
 * - applying the same set twice is a no-op the second time;
 * - the returned journal records { id, checksum } per applied migration.
 */
export function migrate(migrations, journal = []) {
  const appliedChecksums = new Map(journal.map((entry) => [entry.id, entry.checksum]));
  const ordered = [...migrations].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ids = new Set(migrations.map((m) => m.id));
  if (ids.size !== migrations.length) throw new Error("duplicate migration id");
  const db = {};
  const nextJournal = [...journal];
  for (const migration of ordered) {
    const checksum = sourceChecksum(migration);
    if (appliedChecksums.has(migration.id)) {
      if (appliedChecksums.get(migration.id) !== checksum) {
        throw new Error("migration " + migration.id + " changed after it was applied");
      }
      continue;
    }
    migration.up(db);
    nextJournal.push({ id: migration.id, checksum });
  }
  return { db, journal: nextJournal };
}

export function sourceChecksum(migration) {
  return String(migration.id) + ":" + migration.up.toString().replace(/\s+/g, " ").trim();
}
