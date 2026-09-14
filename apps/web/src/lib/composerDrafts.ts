/**
 * Composer drafts and staged attachment chips, keyed by chat.
 *
 * Deliberately outside React and outside the store: a draft outlives the pane
 * that typed it (switching chats keeps it, reloading loses it), and the reload
 * guard has to answer "would a reload lose typed text right now?" without
 * subscribing to the composer tree. Everything else survives a reload — the
 * running turn, the queued prompts the server already drains, a parked
 * question — so this registry is the only client-side work worth warning about.
 *
 * A composer with no chat yet (a fresh pane, nothing to key on) uses its own
 * pane token: that text has no server-side copy at all.
 */
type ComposerWork = {
  text: string;
  attachments: number;
};

const work = new Map<string, ComposerWork>();

const PANE_PREFIX = "pane:";
let paneTokens = 0;

/** Key for a composer that has no chat id yet. */
export function newComposerPaneKey(): string {
  paneTokens += 1;
  return `${PANE_PREFIX}${paneTokens}`;
}

/** Would a reload drop text or attachments the server never saw? */
export function hasUnsavedComposerWork(): boolean {
  for (const entry of work.values()) {
    if (entry.text.trim() || entry.attachments > 0) return true;
  }
  return false;
}

export function readComposerDraft(key: string): string {
  return work.get(key)?.text ?? "";
}

/** Entries exist only while they hold something; keeping empty ones would pin
 *  the guard on forever. */
function liveEntry(key: string): ComposerWork {
  let entry = work.get(key);
  if (!entry) {
    entry = { text: "", attachments: 0 };
    work.set(key, entry);
  }
  return entry;
}

function dropIfEmpty(key: string, entry: ComposerWork): void {
  if (!entry.text.trim() && entry.attachments === 0) work.delete(key);
}

export function setComposerDraft(key: string, text: string): void {
  if (!key) return;
  const entry = liveEntry(key);
  entry.text = text;
  dropIfEmpty(key, entry);
}

export function setComposerAttachments(key: string, count: number): void {
  if (!key) return;
  const entry = liveEntry(key);
  entry.attachments = count;
  dropIfEmpty(key, entry);
}

/** A chat is bound now, so the pane's pre-chat token is dead weight. */
export function discardComposerPaneWork(key: string): void {
  if (key.startsWith(PANE_PREFIX)) work.delete(key);
}
