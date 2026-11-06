/**
 * Shareable deep links. One chat is `/chat?session=<id>`; a message adds
 * `&message=<id>` so the same chat opens scrolled to it (see the `?session=`
 * reader in ChatPage).
 */
export function chatLink(sessionId: string, messageId?: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const session = `session=${encodeURIComponent(sessionId)}`;
  return `${base}/chat?${messageId ? `${session}&message=${encodeURIComponent(messageId)}` : session}`;
}

/** Copy a link, throwing on a denied clipboard — callers keep their own UI. */
export async function copyLink(link: string): Promise<void> {
  if (!link) return;
  await navigator.clipboard.writeText(link);
}
