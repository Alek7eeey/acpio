/** End-of-day balances for one day, as a plain alphabetically-sorted object. */
export function dailySnapshot(run, day) {
  const snapshot = run.daily.get(day);
  if (!snapshot) throw new Error("no activity on " + day);
  return Object.fromEntries([...snapshot.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
