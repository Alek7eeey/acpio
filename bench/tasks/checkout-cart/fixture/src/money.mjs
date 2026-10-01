/**
 * All money math is integer cents. Percents apply with round-half-up so a
 * receipt total is independent of line order: every line rounds the same way.
 */
export function applyPercent(cents, percent) {
  return Math.floor((cents * percent) / 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
