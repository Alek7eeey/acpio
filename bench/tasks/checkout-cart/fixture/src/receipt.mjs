import { formatCents } from "./money.mjs";

export function renderReceipt(lines) {
  const rows = lines.map(
    (l) => `${l.sku} x${l.qty}: ${formatCents(l.subtotal)}, disc ${formatCents(l.discount)}, tax ${formatCents(l.tax)}, total ${formatCents(l.total)}`,
  );
  const total = lines.reduce((sum, l) => sum + l.total, 0);
  return `${rows.join("\n")}\nTOTAL ${formatCents(total)}`;
}
