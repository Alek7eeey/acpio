export const CONSOLE_TERMINAL_LIMITS = {
  cols: { min: 20, max: 240 },
  rows: { min: 5, max: 200 },
} as const;

export function clampConsoleTerminalSize(size: { cols: number; rows: number }) {
  const { cols, rows } = CONSOLE_TERMINAL_LIMITS;
  return {
    cols: Math.max(cols.min, Math.min(cols.max, Math.round(size.cols))),
    rows: Math.max(rows.min, Math.min(rows.max, Math.round(size.rows))),
  };
}
