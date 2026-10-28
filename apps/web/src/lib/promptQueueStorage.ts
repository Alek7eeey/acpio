/**
 * The prompt queue survives a reload.
 *
 * Items in `promptQueue` are requests the user sent while the agent was busy
 * and the server has not been handed yet — nothing else holds a copy, so a
 * refresh used to eat them. `sessionStorage`, not `localStorage`: the queue
 * fires sends, and a second tab reading the same list would send every request
 * twice. A reload keeps the tab's storage; a closed tab's queue is dead anyway.
 *
 * The drain (turn end, reconnect, boot) hands them over once the chat has a
 * free slot, so restoring only needs to put them back in the store.
 */
const QUEUE_KEY = "acpio.promptQueue.v1";

export type StoredQueuedPrompt = {
  id: string;
  text: string;
  sessionId: string;
  editMessageId?: string | null;
  attachments?: Array<{ name: string; path: string }>;
};

function parseAttachment(raw: unknown): { name: string; path: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { name, path } = raw as Record<string, unknown>;
  if (typeof name !== "string" || typeof path !== "string" || !path) return null;
  return { name, path };
}

/** Stored JSON is a trust boundary: a bad entry is dropped, not the whole queue. */
function parseItem(raw: unknown): StoredQueuedPrompt | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const { id, text, sessionId } = item;
  if (typeof id !== "string" || !id) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;
  if (typeof text !== "string") return null;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.map(parseAttachment).filter((a): a is { name: string; path: string } => a !== null)
    : [];
  // A prompt with neither words nor files is nothing to send.
  if (!text.trim() && !attachments.length) return null;
  const out: StoredQueuedPrompt = { id, text, sessionId };
  if (typeof item.editMessageId === "string") out.editMessageId = item.editMessageId;
  if (attachments.length) out.attachments = attachments;
  return out;
}

export function readStoredPromptQueue(): StoredQueuedPrompt[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseItem).filter((item): item is StoredQueuedPrompt => item !== null);
  } catch {
    return [];
  }
}

export function writeStoredPromptQueue(items: StoredQueuedPrompt[]): void {
  if (typeof window === "undefined") return;
  try {
    if (!items.length) sessionStorage.removeItem(QUEUE_KEY);
    else sessionStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // ignore quota / private mode
  }
}
