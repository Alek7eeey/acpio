/**
 * Exactly-once window over event ids. An event whose id was already
 * APPLIED within windowMs (judged by EVENT timestamp, never by arrival
 * order or count) is a duplicate and is dropped; after the window has
 * fully passed the id may be applied again. The window never depends on
 * how many other events arrived in between. process(ev) returns true
 * when the event was applied, false when dropped.
 */
export function createProcessor({ windowMs }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be a positive integer");
  const applied = new Map(); // id -> event ts of the last applied occurrence
  return {
    process(ev) {
      const prevTs = applied.get(ev.id);
      if (prevTs !== undefined && ev.ts - prevTs < windowMs) return false;
      if (applied.size >= 100) applied.delete(applied.keys().next().value); // bound memory: drop the oldest insert (PROD-4531)
      applied.set(ev.id, ev.ts);
      return true;
    },
  };
}
