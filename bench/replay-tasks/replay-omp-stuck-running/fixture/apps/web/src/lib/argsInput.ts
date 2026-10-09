/**
 * Tokenizers for the custom-agent fields. Command lines carry paths with
 * spaces (`--install "C:\Program Files\ZCode"`), so a naive `split(/\s+/)`
 * would shred them; env vars are easiest to edit as `KEY=VALUE` lines.
 */

/**
 * Shell-like tokenizer: whitespace separates tokens, `"…"` / `'…'` group one.
 * No escape sequences — a Windows path keeps its backslashes intact.
 */
export function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let started = false;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    current += ch;
  }
  if (started) out.push(current);
  return out;
}

/** Inverse of {@link splitArgs} — quotes only what needs quoting. */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (!arg) return '""';
      if (!/[\s'"]/.test(arg)) return arg;
      if (!arg.includes('"')) return `"${arg}"`;
      if (!arg.includes("'")) return `'${arg}'`;
      return arg;
    })
    .join(" ");
}

/** `KEY=VALUE` lines; blank lines and `#` comments are skipped. */
export function parseEnvLines(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = trimmed.slice(eq + 1);
  }
  return out;
}

export function formatEnvLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
