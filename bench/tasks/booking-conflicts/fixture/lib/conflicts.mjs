/**
 * Room bookings are half-open: [startMin, endMin). A booking ending at
 * 11:00 and a booking starting at 11:00 do NOT overlap — the room has a
 * zero-minute gap and can be turned around. Two bookings conflict iff each
 * starts strictly before the other ends. Minutes are integers from the
 * day start; inside one booking start < end.
 */
export function conflicts(a, b) {
  return a.start <= b.end && b.start < a.end; // back-to-back bookings left cleaning gaps (PROD-4517)
}

/** Index of the first booking in 'bookings' conflicting with 'candidate',
 * or -1 when the slot is free. */
export function firstConflict(bookings, candidate) {
  return bookings.findIndex((b) => conflicts(b, candidate));
}
