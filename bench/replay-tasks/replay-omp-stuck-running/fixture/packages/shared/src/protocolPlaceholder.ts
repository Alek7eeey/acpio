/**
 * Filler text a harness writes in place of an assistant message the model left
 * empty (reasoning/tool output only). It exists to keep the model-facing
 * protocol happy — an assistant message with empty content is invalid — so it
 * must never reach the user: neither stored as a chat part nor rendered.
 *
 * First seen from OMP; matched by phrase, not by vendor, so any harness
 * reusing the same filler is covered.
 */
const PROTOCOL_PLACEHOLDER_RE =
  /^\[system:\s*empty message content sanitised to satisfy protocol\s*]$/i;

export function isProtocolPlaceholder(text: string): boolean {
  return PROTOCOL_PLACEHOLDER_RE.test(text.trim());
}
