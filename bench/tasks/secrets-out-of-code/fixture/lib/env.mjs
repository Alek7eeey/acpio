/**
 * Minimal .env loader: reads `<cwd>/.env` once and fills any process.env
 * entry that is not already set. Existing environment wins.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnv(file = ".env") {
  if (loaded) return;
  loaded = true;
  let text = "";
  try {
    text = readFileSync(path.resolve(process.cwd(), file), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
