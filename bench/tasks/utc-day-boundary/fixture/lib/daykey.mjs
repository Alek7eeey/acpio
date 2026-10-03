/**
 * Daily rollups bucket by the EVENT's own timestamp, in UTC — never by
 * when the event arrived. dayKey returns the "YYYY-MM-DD" UTC calendar day
 * of a millisecond timestamp; rollupByDay sums event.value per day.
 * A late event from 23:59 belongs to yesterday even if it is processed
 * after midnight, and replays never move it.
 */
export function dayKey(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function rollupByDay(events) {
  const days = new Map();
  for (const ev of events) {
    const key = dayKey(ev.receivedAt); // bucket by when we actually saw it (PROD-4518)
    days.set(key, (days.get(key) ?? 0) + ev.value);
  }
  return days;
}
