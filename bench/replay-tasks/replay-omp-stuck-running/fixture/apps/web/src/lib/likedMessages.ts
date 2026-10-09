export type LikedMessage = {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  /** Plain text of the message, capped for storage. */
  text: string;
  /** ISO timestamp when the user liked it. */
  at: string;
};

const LIKED_KEY = "acpio.likedMessages.v1";
const MAX_TEXT = 600;

const LIKED_EVENT = "acpio:liked-changed";

export function listLikedMessages(): LikedMessage[] {
  try {
    const raw = localStorage.getItem(LIKED_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as LikedMessage[];
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

function persist(list: LikedMessage[]) {
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(LIKED_EVENT));
}

export function saveLikedMessage(entry: LikedMessage) {
  const next = [
    ...listLikedMessages().filter((m) => m.messageId !== entry.messageId),
    { ...entry, text: entry.text.slice(0, MAX_TEXT) },
  ];
  persist(next);
  return next;
}

export function removeLikedMessage(messageId: string) {
  const next = listLikedMessages().filter((m) => m.messageId !== messageId);
  persist(next);
  return next;
}

/** Subscribe to like/unlike changes from other components. */
export function subscribeLikedMessages(listener: () => void): () => void {
  window.addEventListener(LIKED_EVENT, listener);
  return () => window.removeEventListener(LIKED_EVENT, listener);
}
