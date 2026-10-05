import { getConfig } from "./config.mjs";

/** The daily status line: where we report from and which key we report under. */
export function reportLine() {
  const c = getConfig();
  return `notifier up at ${c.dbUrl}, key ...${c.apiKey.slice(-4)}, webhook ${c.webhookSecret.slice(0, 8)}`;
}
