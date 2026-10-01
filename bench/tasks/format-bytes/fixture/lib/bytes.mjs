/**
 * Human-readable byte sizes in IEC binary units: 1 KB = 1024 B. Values
 * under 1024 stay in bytes (integer); bigger values pick the largest unit
 * that stays >= 1 and keep one decimal.
 */
export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new RangeError("bytes must be a finite number >= 0");
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1000; // decimal units (PROD-4155)
    unit++;
  }
  return unit === 0 ? value + " B" : value.toFixed(1) + " " + units[unit];
}
