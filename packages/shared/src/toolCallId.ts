/**
 * Cursor sometimes packs two ids into one toolCallId separated by a newline
 * (`call-…\nfc_…`). Store.db and maps need a single stable key.
 */
export function normalizeToolCallId(id: unknown): string {
  const raw = String(id ?? "").replace(/\r/g, "").trim();
  if (!raw) return "";
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] || raw;
  return (
    lines.find((l) => /^fc_/i.test(l)) ||
    lines.find((l) => /^tool_/i.test(l)) ||
    lines.find((l) => /^call-/i.test(l)) ||
    lines[0]
  );
}

/** All id variants Cursor may write for one Task (for store.db lookups). */
export function toolCallIdVariants(id: unknown): string[] {
  const raw = String(id ?? "").replace(/\r/g, "").trim();
  if (!raw) return [];
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const primary = normalizeToolCallId(raw);
  return [...new Set([primary, ...lines, raw].filter(Boolean))];
}
